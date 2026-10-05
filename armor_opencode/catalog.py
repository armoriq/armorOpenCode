import hashlib
import json
import math
import os
import re
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Tuple

from .model import ModelKey


SOURCE_URL = "https://models.dev/api.json?type=all"
MAX_BYTES = 16 * 1024 * 1024
STALE_DAYS = 7
RATE_FIELDS = ("input", "output", "cache_read", "cache_write")


@dataclass(frozen=True)
class CatalogModel:
    provider_id: str
    model_id: str
    name: Optional[str]
    family: Optional[str]
    rates: Tuple[Optional[float], ...]
    context_window: Optional[int]
    output_limit: Optional[int]
    canonical_model_id: Optional[str]
    unsupported_rate_fields: Tuple[str, ...]


@dataclass(frozen=True)
class CatalogSnapshot:
    source_url: str
    fetched_at: str
    sha256: str
    content_sha256: str
    models: Tuple[CatalogModel, ...]

    def freshness(self) -> str:
        fetched = datetime.fromisoformat(self.fetched_at.replace("Z", "+00:00"))
        return "stale" if datetime.now(timezone.utc) - fetched > timedelta(days=STALE_DAYS) else "fresh"

    def provenance(self) -> dict:
        return {"sourceURL": self.source_url, "fetchedAt": self.fetched_at, "sha256": self.sha256,
                "contentSha256": self.content_sha256, "freshness": self.freshness(), "staleAfterDays": STALE_DAYS}


def _json(raw: bytes) -> dict:
    if len(raw) > MAX_BYTES:
        raise ValueError("Model catalog exceeds the 16 MiB size limit.")
    def reject_constant(value):
        raise ValueError("Model catalog contains a nonfinite number.")
    try:
        data = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("Model catalog must be valid UTF-8 JSON.")
    if not isinstance(data, dict):
        raise ValueError("Model catalog must be a JSON object.")
    return data


def _text(value, field: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError("Model catalog has invalid " + field + ".")
    return value


def _number(value, field: str) -> Optional[float]:
    if value is None:
        return None
    try:
        valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError("Model catalog rates must be finite nonnegative numbers.")
    return float(value)


def _limit(value) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("Model catalog limits must be nonnegative integers.")
    return value


def _providers(data: dict) -> Tuple[dict, Tuple[CatalogModel, ...]]:
    providers = {}
    entries = []
    for provider_id, provider in sorted(data.items()):
        _text(provider_id, "provider ID")
        if not isinstance(provider, dict) or not isinstance(provider.get("models"), dict):
            raise ValueError("Model catalog provider must contain a models object.")
        if provider.get("id", provider_id) != provider_id:
            raise ValueError("Model catalog provider ID does not match its key.")
        models = {}
        for model_id, model in sorted(provider["models"].items()):
            _text(model_id, "model ID")
            if not isinstance(model, dict):
                raise ValueError("Model catalog model must be an object.")
            if model.get("id", model_id) != model_id:
                raise ValueError("Model catalog model ID does not match its key.")
            cost = {} if model.get("cost") is None else model["cost"]
            limits = {} if model.get("limit") is None else model["limit"]
            if not isinstance(cost, dict) or not isinstance(limits, dict):
                raise ValueError("Model catalog cost and limit must be objects.")
            rates = tuple(_number(cost.get(field), field) for field in RATE_FIELDS)
            unsupported = model.get("unsupported_rate_fields", [])
            if not isinstance(unsupported, list) or any(_text(field, "unsupported rate field") is None for field in unsupported):
                raise ValueError("Model catalog unsupported rate fields must be a list of strings.")
            unsupported = tuple(sorted(set(unsupported) | (set(cost) - set(RATE_FIELDS))))
            entry = CatalogModel(provider_id, model_id, _text(model.get("name"), "name"),
                                 _text(model.get("family"), "family"), rates,
                                 _limit(limits.get("context")), _limit(limits.get("output")),
                                 _text(model.get("canonical_model_id"), "canonical model ID"), unsupported)
            entries.append(entry)
            models[model_id] = {"id": model_id, "name": entry.name, "family": entry.family,
                                "cost": dict(zip(RATE_FIELDS, rates)),
                                "limit": {"context": entry.context_window, "output": entry.output_limit},
                                "canonical_model_id": entry.canonical_model_id,
                                "unsupported_rate_fields": list(unsupported)}
        providers[provider_id] = {"models": models}
    if not entries:
        raise ValueError("Model catalog contains no model entries.")
    return providers, tuple(entries)


def _canonical(data: dict) -> bytes:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _digest(value) -> str:
    if not isinstance(value, str) or not re.fullmatch("[a-f0-9]{64}", value):
        raise ValueError("Model catalog must carry valid SHA256 fingerprints.")
    return value


def load_catalog(path: Path) -> CatalogSnapshot:
    with path.open("rb") as stream:
        data = _json(stream.read(MAX_BYTES + 1))
    if type(data.get("catalogSchemaVersion")) is not int or data["catalogSchemaVersion"] != 1 or data.get("sourceURL") != SOURCE_URL:
        raise ValueError("Unsupported model catalog snapshot or source URL.")
    fetched_at = _text(data.get("fetchedAt"), "fetch timestamp")
    if fetched_at is None:
        raise ValueError("Model catalog requires a fetch timestamp.")
    try:
        fetched = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Model catalog fetch timestamp must use ISO8601 with timezone.")
    if fetched.tzinfo is None or fetched > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError("Model catalog fetch timestamp must have timezone and cannot be in the future.")
    raw_providers = data.get("providers")
    if not isinstance(raw_providers, dict):
        raise ValueError("Model catalog requires a providers object.")
    providers, models = _providers(raw_providers)
    content_digest = _digest(data.get("contentSha256"))
    if hashlib.sha256(_canonical(providers)).hexdigest() != content_digest:
        raise ValueError("Model catalog content fingerprint does not match its metadata.")
    return CatalogSnapshot(SOURCE_URL, fetched_at, _digest(data.get("sha256")), content_digest, models)


def refresh_catalog(output: Path) -> CatalogSnapshot:
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "armor-opencode/0.1", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.geturl() != SOURCE_URL:
                raise ValueError("Model catalog source redirected to an unexpected URL.")
            raw = response.read(MAX_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("Model catalog refresh failed; the previous snapshot was preserved.")
    providers, models = _providers(_json(raw))
    data = {"catalogSchemaVersion": 1, "sourceURL": SOURCE_URL,
            "fetchedAt": datetime.now(timezone.utc).isoformat(), "sha256": hashlib.sha256(raw).hexdigest(),
            "contentSha256": hashlib.sha256(_canonical(providers)).hexdigest(), "providers": providers}
    content = _canonical(data)
    if len(content) > MAX_BYTES:
        raise ValueError("Normalized model catalog exceeds the 16 MiB size limit.")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=output.parent, prefix=".model-catalog-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return CatalogSnapshot(SOURCE_URL, data["fetchedAt"], data["sha256"], data["contentSha256"], models)


def model_metadata(key: ModelKey, catalog: Optional[CatalogSnapshot]) -> dict:
    result = {"id": key.label, "providerID": key.provider, "modelID": key.model,
              "displayName": key.model if key.model != "unknown" else "Unknown model",
              "family": "Unknown" if key.model == "unknown" else "Unclassified"}
    entry = next((entry for entry in catalog.models if entry.provider_id == key.provider and entry.model_id == key.model), None) if catalog else None
    metadata = {"match": "not-configured" if catalog is None else "missing" if entry is None else "exact",
                "ratesStatus": "missing", "currentRates": None, "canonicalModelID": None}
    if catalog is not None:
        metadata.update(catalog.provenance())
    if entry is not None:
        result["displayName"] = entry.name or result["displayName"]
        result["family"] = entry.family or result["family"]
        metadata.update(currentRates={"currency": "USD", "unit": "per-million-tokens",
                                      "scope": "base-components-only", "notice": "Base catalog rates only; context tiers, reasoning, and modalities may differ. Not used to reprice historical usage.",
                                      **dict(zip(("input", "output", "cacheRead", "cacheWrite"), entry.rates))},
                        ratesStatus="complete" if all(rate is not None for rate in entry.rates) else "missing" if all(rate is None for rate in entry.rates) else "partial",
                        contextWindow=entry.context_window, outputLimit=entry.output_limit,
                        canonicalModelID=entry.canonical_model_id,
                        hasConditionalRates=bool(entry.unsupported_rate_fields),
                        unsupportedRateFields=list(entry.unsupported_rate_fields))
    result["catalog"] = metadata
    return result
