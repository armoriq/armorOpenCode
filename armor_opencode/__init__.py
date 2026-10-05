from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("armor-opencode")
except PackageNotFoundError:
    __version__ = "development"
