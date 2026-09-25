"""The YAML module the plugin reads and writes Hermes config with.

Hermes through 0.21.x installs PyYAML. Hermes main since 2026-09-24 installs
only ruamel.yaml and ships ``hermes_yaml``, a shim with the same ``safe_load``,
``safe_dump`` and ``YAMLError`` surface this plugin uses. PyYAML wins when it
is present, so released Hermes keeps its exact behaviour; import through
``from .yaml_compat import yaml`` so the plugin loads on either.
"""

try:
    import yaml
except ImportError:  # Hermes main: no PyYAML, ruamel behind hermes_yaml
    import hermes_yaml as yaml

__all__ = ["yaml"]
