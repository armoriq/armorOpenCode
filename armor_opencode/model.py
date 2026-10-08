from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class ModelKey:
    provider: str
    model: str

    @property
    def label(self) -> str:
        return self.provider + "/" + self.model


UNKNOWN_MODEL = ModelKey("unknown", "unknown")


@dataclass(frozen=True)
class Session:
    id: str
    parent_id: Optional[str]
    created_ms: Optional[int]
    updated_ms: Optional[int]
    directory: Optional[str] = None


@dataclass(frozen=True)
class TokenUsage:
    input: Optional[int]
    output: Optional[int]
    reasoning: Optional[int]
    cache_read: Optional[int]
    cache_write: Optional[int]
    reported_total: Optional[int]

    @property
    def total(self) -> Optional[int]:
        parts = (self.input, self.output, self.reasoning, self.cache_read, self.cache_write)
        return None if any(part is None for part in parts) else sum(parts)


@dataclass(frozen=True)
class Message:
    id: str
    session_id: str
    model: ModelKey
    created_ms: Optional[int]
    completed_ms: Optional[int]
    tokens: Optional[TokenUsage]
    cost: Optional[float]


@dataclass(frozen=True)
class UsageStep:
    id: str
    message_id: str
    session_id: str
    model: ModelKey
    created_ms: Optional[int]
    tokens: Optional[TokenUsage]
    cost: Optional[float]
    basis: str
    inherited: bool


@dataclass(frozen=True)
class ToolCall:
    id: str
    message_id: str
    session_id: str
    call_id: Optional[str]
    model: ModelKey
    name: str
    status: str
    created_ms: Optional[int]
    started_ms: Optional[int]
    completed_ms: Optional[int]
    inherited: bool

    @property
    def duration_ms(self) -> Optional[int]:
        if self.started_ms is None or self.completed_ms is None:
            return None
        duration = self.completed_ms - self.started_ms
        return duration if duration >= 0 else None


@dataclass
class Snapshot:
    sessions: Dict[str, Session] = field(default_factory=dict)
    steps: List[UsageStep] = field(default_factory=list)
    tools: List[ToolCall] = field(default_factory=list)
    messages: List[Message] = field(default_factory=list)
    diagnostics: List[dict] = field(default_factory=list)
    source_kinds: Tuple[str, ...] = ()
    source_count: int = 0
    complete: bool = True


@dataclass(frozen=True)
class Filters:
    session: Optional[str] = None
    model: Optional[str] = None
    since: Optional[str] = None
    until: Optional[str] = None
    timezone: str = "UTC"


@dataclass(frozen=True)
class BudgetPolicy:
    session: Optional[int] = None
    total: Optional[int] = None
    sessions: Dict[str, int] = field(default_factory=dict)
