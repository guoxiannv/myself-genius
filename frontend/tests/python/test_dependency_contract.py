from __future__ import annotations

import ast
import importlib.util
import sys
import sysconfig
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]
TEST_TREE = APP_ROOT / "tests" / "python"
RUNTIME_REQUIREMENTS = APP_ROOT / "requirements.txt"
TEST_REQUIREMENTS = APP_ROOT / "requirements-test.txt"

# import 名 -> PyPI 发行包名，仅在两者不一致时才需要登记。
DISTRIBUTION_BY_IMPORT = {"PIL": "pillow"}

_STDLIB_MODULE_NAMES = getattr(sys, "stdlib_module_names", None)


def normalize(name: str) -> str:
    return name.strip().lower().replace("_", "-").replace(".", "-")


def parse_requirements(path: Path) -> dict[str, str]:
    """返回 {规范化包名: 版本约束}；约束为空字符串表示未限定。"""
    declared: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        cut = len(line)
        for index, char in enumerate(line):
            if char in "<>=!~;[ ":
                cut = index
                break
        declared[normalize(line[:cut])] = line[cut:].strip()
    return declared


def is_first_party(module: str) -> bool:
    return (APP_ROOT / f"{module}.py").is_file() or (APP_ROOT / module).is_dir()


def is_stdlib(module: str) -> bool:
    if _STDLIB_MODULE_NAMES is not None:
        return module in _STDLIB_MODULE_NAMES
    # Python 3.9 没有 sys.stdlib_module_names，退回按解析路径判断。
    try:
        spec = importlib.util.find_spec(module)
    except (ImportError, ValueError):
        return False
    if spec is None:
        return False
    if spec.origin in (None, "built-in", "frozen"):
        return True
    stdlib_dir = Path(sysconfig.get_paths()["stdlib"]).resolve()
    return str(Path(spec.origin).resolve()).startswith(str(stdlib_dir))


def guarded_import_nodes(tree: ast.AST) -> set[int]:
    """收集被 try/except ImportError 保护的 import 节点，它们属于可选依赖。"""
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        catches_import_error = any(
            handler.type is not None
            and "ImportError" in ast.dump(handler.type)
            for handler in node.handlers
        )
        if not catches_import_error:
            continue
        for statement in node.body:
            for child in ast.walk(statement):
                if isinstance(child, (ast.Import, ast.ImportFrom)):
                    guarded.add(id(child))
    return guarded


def required_third_party_imports() -> dict[str, set[str]]:
    """返回 {发行包名: 出现该 import 的测试文件相对路径集合}。"""
    found: dict[str, set[str]] = {}
    for source in sorted(TEST_TREE.rglob("*.py")):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        guarded = guarded_import_nodes(tree)
        for node in ast.walk(tree):
            if id(node) in guarded:
                continue
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level or not node.module:
                    continue
                modules = [node.module]
            else:
                continue
            for module in modules:
                top = module.split(".", 1)[0]
                if is_first_party(top) or is_stdlib(top):
                    continue
                distribution = normalize(DISTRIBUTION_BY_IMPORT.get(top, top))
                found.setdefault(distribution, set()).add(
                    str(source.relative_to(APP_ROOT))
                )
    return found


class TestDependencyContract(unittest.TestCase):
    """把「跑测试只需要哪些第三方包」变成会失败的断言，而不是文档里的一句话。"""

    def test_test_tree_imports_stay_within_requirements_test(self) -> None:
        declared = set(parse_requirements(TEST_REQUIREMENTS))
        used = required_third_party_imports()
        undeclared = sorted(set(used) - declared)
        self.assertEqual(
            undeclared,
            [],
            "测试树引入了未在 requirements-test.txt 声明的第三方包："
            + "；".join(
                f"{name}（{'、'.join(sorted(used[name]))}）" for name in undeclared
            )
            + "。要么把该测试改成 try/except ImportError + skipIf 的可选形式，"
            + "要么显式把它加进 requirements-test.txt——后者会抬高所有人跑测试的门槛，"
            + "请确认这是有意的。",
        )

    def test_shared_packages_declare_identical_constraints(self) -> None:
        runtime = parse_requirements(RUNTIME_REQUIREMENTS)
        test = parse_requirements(TEST_REQUIREMENTS)
        conflicts = sorted(
            f"{name}: requirements.txt={runtime[name] or '无约束'} / "
            f"requirements-test.txt={test[name] or '无约束'}"
            for name in set(runtime) & set(test)
            if runtime[name] != test[name]
        )
        self.assertEqual(
            conflicts,
            [],
            "两份依赖清单允许各自增删包，但同名包的版本约束必须一致，"
            "否则测试验证的版本会与线上安装的版本不是同一个：" + "；".join(conflicts),
        )


if __name__ == "__main__":
    unittest.main()
