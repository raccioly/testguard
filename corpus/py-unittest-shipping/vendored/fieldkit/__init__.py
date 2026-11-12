"""A stand-in for a third-party validation library, as a `python setup.py build`
leaves it under build/lib/ (issue #272). Infrastructure written by the corpus
orchestrator, not part of the subject: it is copied into an untracked,
git-ignored build/ directory of each scratch copy and never imported by the
subject's code or tests. Its imports are computed, as such libraries' are."""
import importlib

_VALIDATORS = ("numbers", "strings")


def load(name):
    if name not in _VALIDATORS:
        raise KeyError(name)
    return importlib.import_module(f"{__name__}.validators.{name}")


def __getattr__(attr):
    return getattr(load(attr.split("_", 1)[0]), attr)
