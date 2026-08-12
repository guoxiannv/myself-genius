#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

try:
    import imageio_ffmpeg
except ImportError:  # pragma: no cover
    imageio_ffmpeg = None

APP_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = APP_ROOT / "data"
DEFAULT_VIDEO_ROOT = DATA_ROOT / "artifacts" / "videos"
DEFAULT_REMOTE_TMP_DIR = "/data/local/tmp/genius/frontend"
EXPECTED_HAP_RELATIVE_PATH = Path("entry/build/default/outputs/default/entry-default-unsigned.hap")
SCREENSHOT_SUFFIX = ".png"
REMOTE_SCREENSHOT_SUFFIX = ".jpeg"
DEFAULT_MAX_RUNTIME_SCROLLS = 8
DEFAULT_FFMPEG_CANDIDATES = [
    os.environ.get("FFMPEG_PATH", "").strip(),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
]
DEFAULT_HDC_CANDIDATES = [
    os.environ.get("HDC_PATH", "").strip(),
    os.path.join(
        os.environ.get("DEVECO_PATH", "/Applications/DevEco-Studio.app"),
        "Contents/sdk/default/openharmony/toolchains/hdc",
    ),
    "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_slug(value: str, fallback: str = "capture") -> str:
    normalized = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in str(value).strip().lower())
    normalized = normalized.strip("-_")
    return normalized[:64] or fallback


def read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json_if_exists(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return read_json(path)
    except Exception:
        return {}


def camel_to_kebab(name: str) -> str:
    base = re.sub(r"Page$", "", name or "")
    if not base:
        return "page"
    return re.sub(r"(?<!^)(?=[A-Z])", "-", base).lower()


def extract_first_match(text: str, pattern: str) -> str:
    match = re.search(pattern, text, re.DOTALL)
    return match.group(1).strip() if match else ""


def find_design_manifest_path(workspace: Path) -> Path | None:
    direct = workspace / ".arkpilot" / "designs" / "design-manifest.json"
    if direct.is_file():
        return direct
    for candidate in workspace.rglob("design-manifest.json"):
        if ".git" not in candidate.parts:
            return candidate
    return None


def read_design_manifest(workspace: Path) -> Dict[str, Any]:
    design_manifest_path = find_design_manifest_path(workspace)
    return read_json_if_exists(design_manifest_path) if design_manifest_path else {}


def extract_bundle_name(workspace: Path) -> str:
    app_config_path = workspace / "AppScope" / "app.json5"
    if app_config_path.is_file():
        text = read_text(app_config_path)
        bundle_name = extract_first_match(text, r'"bundleName"\s*:\s*"([^"]+)"')
        if bundle_name:
            return bundle_name

    hap_path = workspace / EXPECTED_HAP_RELATIVE_PATH
    if hap_path.is_file():
        try:
            with zipfile.ZipFile(hap_path) as archive:
                module_json = json.loads(archive.read("module.json").decode("utf-8"))
            bundle_name = str((module_json.get("app") or {}).get("bundleName") or "").strip()
            if bundle_name:
                return bundle_name
        except (KeyError, OSError, zipfile.BadZipFile, json.JSONDecodeError):
            pass

    raise RuntimeError(f"无法从 {app_config_path} 或 {hap_path} 推断 bundleName")


def extract_ability_name(workspace: Path) -> str:
    module_config_path = workspace / "entry" / "src" / "main" / "module.json5"
    text = read_text(module_config_path)
    ability_name = extract_first_match(text, r'"mainElement"\s*:\s*"([^"]+)"')
    return ability_name or "EntryAbility"


def resolve_main_pages_entry_path(workspace: Path) -> Path | None:
    main_pages_path = workspace / "entry" / "src" / "main" / "resources" / "base" / "profile" / "main_pages.json"
    if not main_pages_path.is_file():
        return None
    try:
        payload = read_json(main_pages_path)
    except Exception:
        return None
    pages = payload.get("src")
    if not isinstance(pages, list):
        return None
    for page in pages:
        page_name = str(page or "").strip().lstrip("/")
        if not page_name:
            continue
        candidate = (workspace / "entry" / "src" / "main" / "ets" / f"{page_name}.ets").resolve()
        if candidate.is_file():
            return candidate
    return None


def find_ability_ets_path(workspace: Path, ability_name: str) -> Path | None:
    pattern = re.compile(rf"\bclass\s+{re.escape(ability_name)}\s+extends\s+UIAbility\b")
    search_root = workspace / "entry" / "src" / "main" / "ets"
    if not search_root.is_dir():
        return None
    for candidate in search_root.rglob("*.ets"):
        try:
            text = read_text(candidate)
        except OSError:
            continue
        if pattern.search(text):
            return candidate.resolve()
    return None


def resolve_ability_load_content_path(workspace: Path, ability_name: str) -> Path | None:
    ability_path = find_ability_ets_path(workspace, ability_name)
    if not ability_path or not ability_path.is_file():
        return None
    text = read_text(ability_path)
    page_ref = extract_first_match(text, r"loadContent\(\s*['\"]([^'\"]+)['\"]")
    if not page_ref:
        return None
    candidate = (workspace / "entry" / "src" / "main" / "ets" / f"{page_ref.lstrip('/')}.ets").resolve()
    return candidate if candidate.is_file() else None


def find_entry_ets_path(workspace: Path) -> Path:
    main_pages_candidate = resolve_main_pages_entry_path(workspace)
    if main_pages_candidate:
        return main_pages_candidate

    ability_candidate = resolve_ability_load_content_path(workspace, extract_ability_name(workspace))
    if ability_candidate:
        return ability_candidate

    index_candidate = workspace / "entry" / "src" / "main" / "ets" / "pages" / "Index.ets"
    fallback_index: Path | None = index_candidate if index_candidate.is_file() else None

    for candidate in workspace.rglob("*.ets"):
        try:
            text = read_text(candidate)
        except OSError:
            continue
        if "@Entry" in text:
            resolved = candidate.resolve()
            if resolved != fallback_index:
                return resolved
            fallback_index = resolved

    if fallback_index:
        return fallback_index
    raise RuntimeError(f"未找到可用的入口 ETS 文件: {workspace}")


def extract_import_map(index_path: Path, text: str) -> Dict[str, Path]:
    mapping: Dict[str, Path] = {}
    for match in re.finditer(r'import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+[\'"]([^\'"]+)[\'"]', text):
        component_name = match.group(1)
        import_path = match.group(2)
        resolved = (index_path.parent / f"{import_path}.ets").resolve()
        mapping[component_name] = resolved
    return mapping


def extract_center_tab_title(index_text: str) -> str:
    for builder_name in ("CenterTabBuilder() {", "CenterTabBar() {"):
        start = index_text.find(builder_name)
        if start >= 0:
            segment = index_text[start:start + 1200]
            texts = re.findall(r"Text\(\s*'([^']+)'\s*\)", segment)
            meaningful = [item.strip() for item in texts if item.strip() and item.strip() != "+"]
            if meaningful:
                return meaningful[-1]
    return "center"


def extract_entry_component_name(index_text: str) -> str:
    match = re.search(r"@Entry[\s\S]*?struct\s+([A-Za-z0-9_]+)", index_text)
    return match.group(1).strip() if match else "EntryPage"


def extract_string_literals(text: str) -> List[str]:
    values: List[str] = []
    for single, double in re.findall(r"'([^']+)'|\"([^\"]+)\"", text):
        value = single or double
        if value.strip():
            values.append(value.strip())
    return values


def extract_tab_title(builder_name: str, builder_args: str, center_tab_title: str) -> str:
    if builder_name in {"CenterTabBuilder", "CenterTabBar"}:
        return center_tab_title

    literals = extract_string_literals(builder_args)
    if builder_name in {"TabBuilder", "TabBar"}:
        return literals[-1] if literals else ""

    # Generic builders like TabBarItem(index, 'Today', 'clock') usually place
    # the visible label before auxiliary strings such as icon names.
    return literals[0] if literals else ""


def extract_string_array_values(text: str, variable_names: List[str]) -> List[str]:
    for variable_name in variable_names:
        patterns = [
            rf"\b{re.escape(variable_name)}\b\s*:\s*[A-Za-z0-9_<>\[\]\s]+\s*=\s*\[(.*?)\]",
            rf"\b{re.escape(variable_name)}\b\s*=\s*\[(.*?)\]",
        ]
        for pattern in patterns:
            match = re.search(pattern, text, re.DOTALL)
            if match:
                values = extract_string_literals(match.group(1))
                if values:
                    return values
    return []


def resolve_component_path(index_path: Path, import_map: Dict[str, Path], component_name: str) -> Path:
    return import_map.get(component_name, (index_path.parent / f"{component_name}.ets").resolve())


def page_file_metadata(page_path: Path) -> Dict[str, Any]:
    metadata: Dict[str, Any] = {
        "page_file": str(page_path),
        "scrollable": False,
        "root_id": "",
    }
    if not page_path.is_file():
        return metadata
    text = read_text(page_path)
    metadata["scrollable"] = bool(re.search(r"\b(Scroll|List|Grid|WaterFlow)\s*\(", text))
    root_match = re.search(r"\.id\(\s*'([^']+)'\s*\)|\.id\(\s*\"([^\"]+)\"\s*\)", text)
    if root_match:
        metadata["root_id"] = root_match.group(1) or root_match.group(2) or ""
    return metadata


def match_design_page(design_manifest: Dict[str, Any], title: str, page_key: str) -> Dict[str, Any]:
    pages = design_manifest.get("pages") if isinstance(design_manifest, dict) else []
    if not isinstance(pages, list):
        return {}
    title_norm = safe_slug(title, "")
    page_key_norm = safe_slug(page_key, "")
    for page in pages:
        if not isinstance(page, dict):
            continue
        if safe_slug(str(page.get("pageKey") or ""), "") == page_key_norm:
            return page
        if safe_slug(str(page.get("activeTabLabel") or ""), "") == title_norm:
            return page
    return {}


def build_tab_plan_item(
    slot_index: int,
    tab_name: str,
    title: str,
    component_name: str,
    page_path: Path,
    design_manifest: Dict[str, Any],
    *,
    is_center: bool,
    activate_via_tap: bool,
) -> Dict[str, Any]:
    page_key = safe_slug(tab_name, camel_to_kebab(component_name))
    page_meta = page_file_metadata(page_path)
    design_page = match_design_page(design_manifest, title, page_key)
    return {
        "slot_index": slot_index,
        "name": page_key,
        "title": title,
        "component_name": component_name,
        "page_file": str(page_path),
        "scrollable": bool(page_meta["scrollable"]),
        "root_id": page_meta["root_id"],
        "is_center": is_center,
        "scroll_count": 1 if page_meta["scrollable"] else 0,
        "design_page": design_page,
        "is_primary": bool(design_page.get("isPrimaryPage", True)) if design_page else True,
        "activate_via_tap": activate_via_tap,
    }


def extract_system_tabs(
    index_path: Path,
    index_text: str,
    import_map: Dict[str, Path],
    design_manifest: Dict[str, Any],
) -> List[Dict[str, Any]]:
    center_tab_title = extract_center_tab_title(index_text)
    pattern = re.compile(
        r"TabContent\(\)\s*\{\s*([A-Za-z0-9_]+)\s*\([\s\S]*?\)\s*\}\s*"
        r"\.tabBar\(\s*(?:this\.)?([A-Za-z0-9_]+)\((.*?)\)\s*\)",
        re.DOTALL,
    )
    tabs: List[Dict[str, Any]] = []
    for slot_index, match in enumerate(pattern.finditer(index_text)):
        component_name = match.group(1)
        builder_name = match.group(2)
        builder_args = match.group(3)
        is_center_builder = builder_name in {"CenterTabBuilder", "CenterTabBar"}
        title = extract_tab_title(builder_name, builder_args, center_tab_title) or component_name
        page_path = resolve_component_path(index_path, import_map, component_name)
        tabs.append(
            build_tab_plan_item(
                slot_index,
                camel_to_kebab(component_name),
                title,
                component_name,
                page_path,
                design_manifest,
                is_center=is_center_builder,
                activate_via_tap=True,
            )
        )
    tabbar_component_name = extract_interactive_tabbar_component_name(index_text, import_map)
    tabbar_path = resolve_component_path(index_path, import_map, tabbar_component_name) if tabbar_component_name else None
    tabbar_items = extract_custom_tabbar_items(tabbar_path) if tabbar_path else []
    if len(tabbar_items) >= len(tabs):
        for slot_index, tab in enumerate(tabs):
            item = tabbar_items[slot_index]
            tab["name"] = safe_slug(item["id"], tab["name"])
            tab["title"] = item["label"] or tab["title"]
    return tabs


def extract_active_tab_branches(index_text: str) -> List[Tuple[str, str]]:
    branches: List[Tuple[str, str]] = []
    pattern = re.compile(
        r"(?:if|else\s+if)\s*\(\s*this\.activeTab\s*===\s*['\"]([^'\"]+)['\"]\s*\)\s*\{\s*([A-Za-z0-9_]+)\s*\(",
        re.DOTALL,
    )
    for match in pattern.finditer(index_text):
        tab_id = match.group(1).strip()
        component_name = match.group(2).strip()
        if tab_id and component_name:
            branches.append((tab_id, component_name))
    return branches


def extract_custom_tabbar_component_name(index_text: str) -> str:
    match = re.search(
        r"([A-Za-z0-9_]+)\(\{\s*activeTab\s*:\s*this\.activeTab[\s\S]{0,600}?onTabChange\s*:",
        index_text,
        re.DOTALL,
    )
    return match.group(1).strip() if match else ""


def extract_custom_tabbar_items(tabbar_path: Path) -> List[Dict[str, str]]:
    if not tabbar_path.is_file():
        return []
    text = read_text(tabbar_path)
    items: List[Dict[str, str]] = []
    pattern = re.compile(
        r"\{\s*id:\s*['\"]([^'\"]+)['\"]\s*,\s*label:\s*['\"]([^'\"]+)['\"]",
        re.DOTALL,
    )
    for match in pattern.finditer(text):
        items.append({"id": match.group(1).strip(), "label": match.group(2).strip()})
    if items:
        return items

    tab_ids = extract_string_array_values(text, ["tabList", "tabKeys", "TAB_KEYS"])
    tab_labels = extract_string_array_values(text, ["tabLabels", "labels", "TAB_LABELS"])
    if tab_ids and tab_labels and len(tab_ids) == len(tab_labels):
        return [{"id": tab_id.strip(), "label": tab_labels[index].strip()} for index, tab_id in enumerate(tab_ids)]
    return items


def extract_interactive_tabbar_component_name(index_text: str, import_map: Dict[str, Path]) -> str:
    prop_patterns = (
        "activeTab",
        "activeIndex",
        "currentIndex",
        "selectedIndex",
        "selectedTab",
    )
    for component_name in import_map:
        pattern = re.compile(rf"{re.escape(component_name)}\(\{{", re.DOTALL)
        match = pattern.search(index_text)
        if not match:
            continue
        segment = index_text[match.start():match.start() + 2200]
        if "onTabChange" not in segment:
            continue
        if any(re.search(rf"\b{prop_name}\s*:", segment) for prop_name in prop_patterns):
            return component_name
    return ""


def extract_index_state_branches(index_text: str) -> Tuple[str, List[Tuple[int, str]]]:
    pattern = re.compile(
        r"(?:if|else\s+if)\s*\(\s*this\.([A-Za-z0-9_]+)\s*===\s*(\d+)\s*\)\s*\{\s*([A-Za-z0-9_]+)\s*\(",
        re.DOTALL,
    )
    branches_by_state: Dict[str, List[Tuple[int, str]]] = {}
    for match in pattern.finditer(index_text):
        state_name = match.group(1).strip()
        slot_index = int(match.group(2))
        component_name = match.group(3).strip()
        if not state_name or not component_name:
            continue
        branches_by_state.setdefault(state_name, []).append((slot_index, component_name))

    if not branches_by_state:
        return "", []

    state_name, branches = max(branches_by_state.items(), key=lambda item: len(item[1]))
    deduped = {slot_index: component_name for slot_index, component_name in branches}
    ordered = sorted(deduped.items(), key=lambda item: item[0])
    return state_name, ordered


def extract_index_tabbar_component_name(index_text: str, state_name: str, import_map: Dict[str, Path]) -> str:
    if not state_name:
        return ""
    for component_name in import_map:
        pattern = re.compile(rf"{re.escape(component_name)}\(\{{", re.DOTALL)
        match = pattern.search(index_text)
        if not match:
            continue
        segment = index_text[match.start():match.start() + 1600]
        if (
            re.search(rf"(?:activeIndex|currentIndex|selectedIndex)\s*:\s*this\.{re.escape(state_name)}", segment)
            and "onTabChange" in segment
        ):
            return component_name
    return ""


def extract_tabbar_labels(tabbar_path: Path) -> List[str]:
    if not tabbar_path.is_file():
        return []
    text = read_text(tabbar_path)
    labels: List[str] = []
    for match in re.finditer(r"label:\s*['\"]([^'\"]+)['\"]", text):
        label = match.group(1).strip()
        if label:
            labels.append(label)
    return labels


def extract_index_tabs(
    index_path: Path,
    index_text: str,
    import_map: Dict[str, Path],
    design_manifest: Dict[str, Any],
) -> List[Dict[str, Any]]:
    state_name, branches = extract_index_state_branches(index_text)
    if not state_name or not branches:
        return []

    tabbar_component_name = extract_index_tabbar_component_name(index_text, state_name, import_map)
    tabbar_path = resolve_component_path(index_path, import_map, tabbar_component_name) if tabbar_component_name else None
    tabbar_labels = extract_tabbar_labels(tabbar_path) if tabbar_path else []

    tabs: List[Dict[str, Any]] = []
    for slot_index, component_name in branches:
        title = tabbar_labels[slot_index] if slot_index < len(tabbar_labels) else component_name
        page_path = resolve_component_path(index_path, import_map, component_name)
        tabs.append(
            build_tab_plan_item(
                slot_index,
                safe_slug(title, camel_to_kebab(component_name)),
                title,
                component_name,
                page_path,
                design_manifest,
                is_center=False,
                activate_via_tap=bool(tabbar_component_name),
            )
        )
    return tabs


def extract_custom_tabs(
    index_path: Path,
    index_text: str,
    import_map: Dict[str, Path],
    design_manifest: Dict[str, Any],
) -> List[Dict[str, Any]]:
    branches = extract_active_tab_branches(index_text)
    if not branches:
        return []

    branch_map = {tab_id: component_name for tab_id, component_name in branches}
    tabbar_component_name = extract_custom_tabbar_component_name(index_text)
    tabbar_path = resolve_component_path(index_path, import_map, tabbar_component_name) if tabbar_component_name else None
    tabbar_items = extract_custom_tabbar_items(tabbar_path) if tabbar_path else []

    tabs: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()

    # Prefer the visual order declared by the custom TabBar component.
    for slot_index, item in enumerate(tabbar_items):
        tab_id = item["id"]
        component_name = branch_map.get(tab_id)
        if not component_name:
            continue
        page_path = resolve_component_path(index_path, import_map, component_name)
        tabs.append(
            build_tab_plan_item(
                slot_index,
                tab_id,
                item["label"] or component_name,
                component_name,
                page_path,
                design_manifest,
                is_center=False,
                activate_via_tap=True,
            )
        )
        seen_ids.add(tab_id)

    if tabs:
        return tabs

    for tab_id, component_name in branches:
        page_path = resolve_component_path(index_path, import_map, component_name)
        tabs.append(
            build_tab_plan_item(
                len(tabs),
                tab_id,
                component_name,
                component_name,
                page_path,
                design_manifest,
                is_center=False,
                activate_via_tap=False,
            )
        )

    return tabs


def infer_capture_plan(workspace: Path) -> Dict[str, Any]:
    index_path = find_entry_ets_path(workspace)
    index_text = read_text(index_path)
    import_map = extract_import_map(index_path, index_text)
    design_manifest = read_design_manifest(workspace)
    entry_component_name = extract_entry_component_name(index_text)

    tabs = extract_system_tabs(index_path, index_text, import_map, design_manifest)
    if not tabs:
        tabs = extract_custom_tabs(index_path, index_text, import_map, design_manifest)
    if not tabs:
        tabs = extract_index_tabs(index_path, index_text, import_map, design_manifest)

    if not tabs:
        tabs.append(
            build_tab_plan_item(
                0,
                camel_to_kebab(entry_component_name),
                entry_component_name,
                entry_component_name,
                index_path,
                design_manifest,
                is_center=False,
                activate_via_tap=False,
            )
        )

    return {
        "bundle_name": extract_bundle_name(workspace),
        "ability_name": extract_ability_name(workspace),
        "index_ets_path": str(index_path),
        "design_manifest_path": str(find_design_manifest_path(workspace) or ""),
        "remote_tmp_dir": DEFAULT_REMOTE_TMP_DIR,
        "post_install_wait_sec": 2.0,
        "post_launch_wait_sec": 3.0,
        "pre_actions": [],
        "post_actions": [{"type": "key", "key": "Home", "wait_after_sec": 1.0}],
        "tabs": tabs,
    }


def read_screen_size(image_path: Path) -> Tuple[int, int]:
    if Image is None:
        raise RuntimeError("当前 Python 环境缺少 Pillow，无法读取截图尺寸。")
    with Image.open(image_path) as current:
        return current.size


def apply_geometry_to_plan(plan: Dict[str, Any], screen_width: int, screen_height: int) -> Dict[str, Any]:
    tabs = plan.get("tabs") or []
    tab_count = max(len(tabs), 1)
    base_y = int(screen_height * 0.92)
    center_y = int(screen_height * 0.90)
    for tab in tabs:
        if bool(tab.get("activate_via_tap", True)):
            slot_index = int(tab.get("slot_index", 0))
            tab["tap"] = {
                "x": int(screen_width * ((slot_index + 0.5) / tab_count)),
                "y": center_y if tab.get("is_center") else base_y,
            }
        else:
            tab["tap"] = {}
        if int(tab.get("scroll_count", 0)) > 0:
            tab["scrolls"] = [
                {
                    "x1": int(screen_width * 0.5),
                    "y1": int(screen_height * 0.78),
                    "x2": int(screen_width * 0.5),
                    "y2": int(screen_height * 0.34),
                    "duration_ms": 550,
                    "wait_after_sec": 1.0,
                    "capture_wait_after_sec": 0.12,
                }
            ]
            tab["runtime_scroll_detection"] = bool(tab.get("runtime_scroll_detection", True))
            tab["max_runtime_scrolls"] = max(int(tab.get("max_runtime_scrolls", DEFAULT_MAX_RUNTIME_SCROLLS)), 1)
        else:
            tab["scrolls"] = []
            tab["runtime_scroll_detection"] = False
        tab["capture_before_scroll"] = True
        tab["wait_after_tap_sec"] = 1.0
        tab["tab_intro_hold_frames"] = max(int(tab.get("tab_intro_hold_frames", 4)), 1)
        tab["scroll_capture_steps"] = max(int(tab.get("scroll_capture_steps", 4)), 1)
    plan["screen"] = {"width": screen_width, "height": screen_height}
    return plan


def resolve_hdc_binary() -> str:
    for candidate in DEFAULT_HDC_CANDIDATES:
        if candidate and Path(candidate).exists():
            return candidate
    system_hdc = shutil.which("hdc")
    if system_hdc:
        return system_hdc
    raise RuntimeError(
        "未找到 hdc。请设置 HDC_PATH，或确认 /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc 存在。"
    )


def list_targets(hdc_bin: str) -> List[str]:
    try:
        result = subprocess.run(
            [hdc_bin, "list", "targets"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        error = (exc.stderr or "") if isinstance(exc.stderr, str) else ""
        detail = (error or output or "hdc list targets timed out").strip()
        raise RuntimeError(f"列出 hdc targets 超时: {detail}") from exc
    if result.returncode != 0:
        raise RuntimeError(f"列出 hdc targets 失败: {result.stderr.strip() or result.stdout.strip()}")
    targets: List[str] = []
    for line in result.stdout.splitlines():
        target = line.strip()
        if not target or target == "[Empty]":
            continue
        targets.append(target)
    return targets


def resolve_target(hdc_bin: str, preferred_target: str) -> str:
    targets = list_targets(hdc_bin)
    if preferred_target:
        if preferred_target not in targets:
            raise RuntimeError(f"指定 target 不在已连接设备列表中: {preferred_target}; 当前设备: {targets or '[]'}")
        return preferred_target
    if len(targets) == 1:
        return targets[0]
    if not targets:
        raise RuntimeError("当前没有可用的 HarmonyOS 设备/模拟器，请先连接设备。")
    raise RuntimeError(f"检测到多个 target，请显式传 --target。当前设备: {targets}")


def find_latest_hap(workspace: Path) -> Path:
    hap_path = workspace / EXPECTED_HAP_RELATIVE_PATH
    if not hap_path.is_file():
        raise RuntimeError(f"未找到固定 HAP 路径: {hap_path}")
    return hap_path


@dataclass
class CaptureContext:
    hdc_bin: str
    target: str
    output_dir: Path
    screenshots_dir: Path
    manifest_path: Path
    remote_tmp_dir: str
    manifest: Dict[str, Any]

    def record(self, step_type: str, detail: Dict[str, Any]) -> None:
        self.manifest.setdefault("steps", []).append(
            {
                "at": now_iso(),
                "type": step_type,
                **detail,
            }
        )
        write_json(self.manifest_path, self.manifest)


def run_hdc(ctx: CaptureContext, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    command = [ctx.hdc_bin, "-t", ctx.target, *args]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    ctx.record(
        "hdc-command",
        {
            "command": command,
            "returncode": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
        },
    )
    combined_output = "\n".join(part for part in (stdout, stderr) if part)
    if check and (
        result.returncode != 0
        or re.search(r"(^|\n)(error:|\[Fail\])", combined_output, re.IGNORECASE)
    ):
        raise RuntimeError(f"命令失败: {' '.join(command)}\n{combined_output}")
    return result


def sleep_and_record(ctx: CaptureContext, seconds: float, reason: str) -> None:
    if seconds <= 0:
        return
    ctx.record("sleep", {"seconds": seconds, "reason": reason})
    time.sleep(seconds)


def install_hap(ctx: CaptureContext, hap_path: Path, bundle_name: str = "") -> None:
    if bundle_name:
        run_hdc(ctx, "shell", "aa", "force-stop", bundle_name, check=False)
        run_hdc(ctx, "shell", "bm", "uninstall", "-n", bundle_name, check=False)
    run_hdc(ctx, "install", "-r", str(hap_path))
    ctx.record("install", {"hap_path": str(hap_path), "bundle_name": bundle_name})


def launch_app(ctx: CaptureContext, bundle_name: str, ability_name: str) -> None:
    if not bundle_name:
        return
    run_hdc(ctx, "shell", "aa", "start", "-b", bundle_name, "-a", ability_name or "EntryAbility")
    ctx.record("launch", {"bundle_name": bundle_name, "ability_name": ability_name or "EntryAbility"})


def click(ctx: CaptureContext, x: int, y: int, label: str = "") -> None:
    run_hdc(ctx, "shell", "uitest", "uiInput", "click", str(x), str(y))
    ctx.record("click", {"x": x, "y": y, "label": label})


def swipe(ctx: CaptureContext, x1: int, y1: int, x2: int, y2: int, duration_ms: int, label: str = "") -> None:
    run_hdc(
        ctx,
        "shell",
        "uitest",
        "uiInput",
        "swipe",
        str(x1),
        str(y1),
        str(x2),
        str(y2),
        str(duration_ms),
    )
    ctx.record(
        "swipe",
        {
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "duration_ms": duration_ms,
            "label": label,
        },
    )


def key_event(ctx: CaptureContext, key_name: str) -> None:
    run_hdc(ctx, "shell", "uitest", "uiInput", "keyEvent", key_name)
    ctx.record("key", {"key": key_name})


def ensure_remote_tmp_dir(ctx: CaptureContext) -> None:
    run_hdc(ctx, "shell", "mkdir", "-p", ctx.remote_tmp_dir)


def capture_screenshot(ctx: CaptureContext, label: str) -> Path:
    safe_label = safe_slug(label, "screen")
    remote_path = f"{ctx.remote_tmp_dir}/{safe_label}{REMOTE_SCREENSHOT_SUFFIX}"
    local_path = ctx.screenshots_dir / f"{safe_label}{SCREENSHOT_SUFFIX}"
    local_jpeg_path = ctx.screenshots_dir / f"{safe_label}{REMOTE_SCREENSHOT_SUFFIX}"
    run_hdc(ctx, "shell", "snapshot_display", "-f", remote_path)
    run_hdc(ctx, "file", "recv", remote_path, str(local_jpeg_path))
    if Image is None:
        raise RuntimeError("当前 Python 环境缺少 Pillow，无法将截图从 JPEG 转为 PNG。")
    with Image.open(local_jpeg_path) as screenshot:
        screenshot.save(local_path, format="PNG")
    local_jpeg_path.unlink(missing_ok=True)
    ctx.record(
        "screenshot",
        {
            "label": safe_label,
            "remote_path": remote_path,
            "local_recv_path": str(local_jpeg_path),
            "local_path": str(local_path),
        },
    )
    return local_path


def parse_ui_bounds(bounds_text: str) -> Optional[Tuple[int, int, int, int]]:
    if not bounds_text:
        return None
    matches = re.findall(r"\[(\d+),(\d+)\]", bounds_text)
    if len(matches) < 2:
        return None
    x1, y1 = map(int, matches[0])
    x2, y2 = map(int, matches[1])
    return x1, y1, x2, y2


def bounds_area(bounds: Optional[Tuple[int, int, int, int]]) -> int:
    if not bounds:
        return 0
    x1, y1, x2, y2 = bounds
    return max(0, x2 - x1) * max(0, y2 - y1)


def bounds_center(bounds: Tuple[int, int, int, int]) -> Tuple[int, int]:
    x1, y1, x2, y2 = bounds
    return (x1 + x2) // 2, (y1 + y2) // 2


def normalize_anchor_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def capture_ui_dump(ctx: CaptureContext, label: str) -> Dict[str, Any]:
    safe_label = safe_slug(label, "ui-dump")
    timestamp = time.time_ns()
    remote_path = f"{ctx.remote_tmp_dir}/{safe_label}_{timestamp}.json"
    dumps_dir = ctx.output_dir / "runtime-dumps"
    dumps_dir.mkdir(parents=True, exist_ok=True)
    local_path = dumps_dir / f"{safe_label}_{timestamp}.json"
    run_hdc(ctx, "shell", "uitest", "dumpLayout", "-p", remote_path)
    run_hdc(ctx, "file", "recv", remote_path, str(local_path))
    run_hdc(ctx, "shell", "rm", "-f", remote_path, check=False)
    payload = read_json(local_path)
    ctx.record(
        "ui-dump",
        {
            "label": safe_label,
            "remote_path": remote_path,
            "local_path": str(local_path),
        },
    )
    return payload


def find_text_bounds_in_ui_dump(
    ui_dump: Dict[str, Any],
    target_text: str,
    *,
    min_y: int = 0,
) -> Optional[Tuple[int, int, int, int]]:
    normalized_target = normalize_anchor_text(target_text)
    if not normalized_target:
        return None
    candidates: List[Tuple[int, int, Tuple[int, int, int, int]]] = []
    for _, node in walk_ui_tree(ui_dump):
        attrs = node.get("attributes") or {}
        bounds = parse_ui_bounds(str(attrs.get("bounds") or ""))
        if not bounds:
            continue
        if bounds[1] < min_y:
            continue
        text = normalize_anchor_text(str(attrs.get("text") or ""))
        if text != normalized_target:
            continue
        candidates.append((bounds_center(bounds)[1], bounds_area(bounds), bounds))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][2]


def resolve_runtime_tab_tap(ctx: CaptureContext, tab_name: str, tab: Dict[str, Any]) -> Dict[str, int]:
    fallback_tap = tab.get("tap") or {}
    title = normalize_anchor_text(str(tab.get("title") or ""))
    screen = ctx.manifest.get("screen") or {}
    screen_height = int(screen.get("height") or 0)
    search_min_y = max(int(screen_height * 0.72), screen_height - 520) if screen_height > 0 else 0
    ui_dump = capture_ui_dump(ctx, f"{tab_name}_tab_target")
    bounds = find_text_bounds_in_ui_dump(ui_dump, title, min_y=search_min_y)
    if not bounds:
        return fallback_tap
    x, y = bounds_center(bounds)
    return {"x": x, "y": y}


def walk_ui_tree(node: Dict[str, Any], depth: int = 0) -> List[Tuple[int, Dict[str, Any]]]:
    entries: List[Tuple[int, Dict[str, Any]]] = [(depth, node)]
    for child in node.get("children", []) or []:
        if isinstance(child, dict):
            entries.extend(walk_ui_tree(child, depth + 1))
    return entries


def analyze_scroll_runtime_state(ui_dump: Dict[str, Any]) -> Dict[str, Any]:
    root_bounds = parse_ui_bounds(str((ui_dump.get("attributes") or {}).get("bounds") or "")) or (0, 0, 0, 0)
    screen_w = max(root_bounds[2] - root_bounds[0], 1)
    screen_h = max(root_bounds[3] - root_bounds[1], 1)
    preferred_types = {"Scroll": 4, "List": 4, "Grid": 4, "WaterFlow": 4, "Swiper": 2}
    candidates: List[Tuple[int, int, Tuple[int, int, int, int], str]] = []

    for depth, node in walk_ui_tree(ui_dump):
        attrs = node.get("attributes") or {}
        bounds = parse_ui_bounds(str(attrs.get("bounds") or ""))
        node_type = str(attrs.get("type") or "")
        scrollable = str(attrs.get("scrollable") or "")
        if (
            bounds
            and scrollable == "true"
            and node_type in preferred_types
            and node_type not in {"TextInput", "TextArea"}
        ):
            height = bounds[3] - bounds[1]
            width = bounds[2] - bounds[0]
            if height >= max(320, int(screen_h * 0.35)) and width >= max(320, int(screen_w * 0.5)):
                candidates.append((depth, preferred_types[node_type], bounds, node_type))

    viewport: Optional[Tuple[int, int, int, int]] = None
    viewport_type = ""
    if candidates:
        max_area = max(bounds_area(item[2]) for item in candidates)
        filtered = [item for item in candidates if bounds_area(item[2]) >= max_area * 0.9]
        filtered.sort(key=lambda item: (item[0], item[1], bounds_area(item[2])), reverse=True)
        _, _, viewport, viewport_type = filtered[0]

    anchor_entries: List[Tuple[int, int, str, Tuple[int, int, int, int]]] = []
    node_entries: List[Tuple[int, int, str, Tuple[int, int, int, int]]] = []
    if viewport:
        vx1, vy1, vx2, vy2 = viewport
        for _, node in walk_ui_tree(ui_dump):
            attrs = node.get("attributes") or {}
            bounds = parse_ui_bounds(str(attrs.get("bounds") or ""))
            if not bounds:
                continue
            x1, y1, x2, y2 = bounds
            if y2 <= vy1 or y1 >= vy2 or x2 <= vx1 or x1 >= vx2:
                continue
            text = normalize_anchor_text(str(attrs.get("text") or ""))
            node_type = str(attrs.get("type") or "")
            clickable = str(attrs.get("clickable") or "")
            cx, cy = bounds_center(bounds)
            if node_type == "Text" and text:
                anchor_entries.append((cy, cx, text, bounds))
            elif clickable == "true" and node_type in {"Row", "Stack", "Column", "Image", "Button", "TextInput"}:
                node_entries.append((cy, cx, node_type, bounds))

    tokens: List[str] = []
    seen: set[str] = set()
    for cy, cx, text, _ in sorted(anchor_entries, key=lambda item: (item[0], item[1])):
        bucket_y = max(0, int((cy - viewport[1]) / 60)) if viewport else 0
        bucket_x = max(0, int((cx - viewport[0]) / 80)) if viewport else 0
        token = f"{text[:40]}@{bucket_x}:{bucket_y}"
        if token not in seen:
            seen.add(token)
            tokens.append(token)
        if len(tokens) >= 14:
            break

    if not tokens:
        for cy, cx, node_type, _ in sorted(node_entries, key=lambda item: (item[0], item[1])):
            bucket_y = max(0, int((cy - viewport[1]) / 60)) if viewport else 0
            bucket_x = max(0, int((cx - viewport[0]) / 80)) if viewport else 0
            token = f"{node_type}@{bucket_x}:{bucket_y}"
            if token not in seen:
                seen.add(token)
                tokens.append(token)
            if len(tokens) >= 14:
                break

    if anchor_entries:
        max_anchor_bottom = max(bounds[3] for _, _, _, bounds in anchor_entries)
    elif node_entries:
        max_anchor_bottom = max(bounds[3] for _, _, _, bounds in node_entries)
    elif viewport:
        max_anchor_bottom = viewport[1]
    else:
        max_anchor_bottom = 0

    if viewport:
        viewport_h = viewport[3] - viewport[1]
        bottom_gap = max(0, viewport[3] - max_anchor_bottom)
    else:
        viewport_h = 0
        bottom_gap = 0

    content_reaches_bottom = viewport_h > 0 and bottom_gap <= max(180, int(viewport_h * 0.14))
    low_content = viewport_h > 0 and len(tokens) <= 3 and bottom_gap >= max(220, int(viewport_h * 0.30))
    scrollable = viewport is not None

    return {
        "scrollable": scrollable,
        "viewport": viewport,
        "viewport_type": viewport_type,
        "anchor_count": len(tokens),
        "anchor_signature": "|".join(tokens),
        "bottom_gap": bottom_gap,
        "content_reaches_bottom": content_reaches_bottom,
        "low_content": low_content,
    }


def classify_runtime_precheck(state: Dict[str, Any]) -> Tuple[str, str]:
    viewport_type = str(state.get("viewport_type") or "scroll")
    anchor_count = int(state.get("anchor_count") or 0)
    if not bool(state.get("scrollable")):
        return "page_not_scrollable", "No primary scrollable container found in runtime dump"
    if bool(state.get("low_content")):
        return "page_not_scrollable", "Page has too little visible content to justify scrolling"
    return "precheck_ready", f"Primary {viewport_type} container detected with {anchor_count} anchors"


def classify_runtime_scroll_transition(before_state: Dict[str, Any], after_state: Dict[str, Any]) -> Tuple[str, str]:
    if not bool(before_state.get("scrollable")) or not bool(after_state.get("scrollable")):
        return "page_not_scrollable", "No primary scrollable container found around scroll verification"
    if str(before_state.get("anchor_signature") or "") != str(after_state.get("anchor_signature") or ""):
        return "scroll_effective", "Visible anchors changed after scroll"
    if bool(before_state.get("low_content")) and bool(after_state.get("low_content")):
        return "page_not_scrollable", "Visible content is too short to scroll"
    if bool(before_state.get("content_reaches_bottom")) and bool(after_state.get("content_reaches_bottom")):
        return "already_at_bottom", "Visible anchors stayed the same and content already reaches the viewport bottom"
    if int(after_state.get("bottom_gap") or 0) < int(before_state.get("bottom_gap") or 0):
        return "scroll_effective", "Bottom gap shrank after scroll, content likely moved"
    return "scroll_not_effective", "Scroll gesture did not change visible anchors"


def execute_scroll_round(
    ctx: CaptureContext,
    tab_name: str,
    scroll_index: int,
    scroll: Dict[str, Any],
    scroll_capture_steps: int,
    capture_index: int,
    frame_targets: List[List[Path]],
) -> int:
    step_scrolls = split_swipe_into_steps(scroll, scroll_capture_steps)
    for step_index, step_scroll in enumerate(step_scrolls, start=1):
        swipe(
            ctx,
            int(step_scroll["x1"]),
            int(step_scroll["y1"]),
            int(step_scroll["x2"]),
            int(step_scroll["y2"]),
            int(step_scroll["duration_ms"]),
            f"{tab_name}_scroll_{scroll_index}_{step_index}",
        )
        sleep_and_record(
            ctx,
            float(step_scroll.get("wait_after_sec", 0.15)),
            f"after-scroll-{tab_name}-{scroll_index}-{step_index}",
        )
        frame_path = capture_screenshot(ctx, f"{tab_name}_{capture_index}")
        append_frame_to_targets(frame_path, frame_targets)
        capture_index += 1
    return capture_index


def resolve_ffmpeg_binary() -> str:
    for candidate in [shutil.which("ffmpeg") or "", *DEFAULT_FFMPEG_CANDIDATES]:
        if candidate and Path(candidate).is_file():
            return candidate
    if imageio_ffmpeg is not None:
        try:
            return str(imageio_ffmpeg.get_ffmpeg_exe())
        except Exception:
            pass
    raise RuntimeError("未找到 ffmpeg；请先安装 ffmpeg 并确保它在 PATH 中。")


def build_mp4_with_ffmpeg(image_paths: List[Path], output_path: Path, frame_ms: int) -> None:
    if not image_paths:
        raise RuntimeError("没有可用于生成 MP4 的截图。")
    ffmpeg_bin = resolve_ffmpeg_binary()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    frame_rate = 1000.0 / max(int(frame_ms), 1)
    try:
        with tempfile.TemporaryDirectory(prefix="hdc-runtime-capture-frames-") as frames_dir_str:
            frames_dir = Path(frames_dir_str)
            for frame_index, image_path in enumerate(image_paths, start=1):
                staged_path = frames_dir / f"frame-{frame_index:06d}.png"
                try:
                    os.symlink(image_path, staged_path)
                except OSError:
                    shutil.copy2(image_path, staged_path)
            subprocess.run(
                [
                    ffmpeg_bin,
                    "-y",
                    "-framerate",
                    f"{frame_rate:.6f}",
                    "-i",
                    str(frames_dir / "frame-%06d.png"),
                    "-an",
                    "-c:v",
                    "libx264",
                    "-r",
                    f"{frame_rate:.6f}",
                    "-vf",
                    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    str(output_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
    except subprocess.CalledProcessError as exc:
        combined_output = "\n".join(part for part in (exc.stdout, exc.stderr) if part)
        raise RuntimeError(f"ffmpeg 生成 MP4 失败:\n{combined_output}") from exc


def split_swipe_into_steps(scroll: Dict[str, Any], step_count: int) -> List[Dict[str, Any]]:
    step_total = max(int(step_count), 1)
    x1 = int(scroll["x1"])
    y1 = int(scroll["y1"])
    x2 = int(scroll["x2"])
    y2 = int(scroll["y2"])
    duration_ms = int(scroll.get("duration_ms", 500))
    default_wait = float(scroll.get("wait_after_sec", 1.0))
    step_wait = float(scroll.get("capture_wait_after_sec", min(default_wait, 0.2)))
    step_duration = max(int(round(duration_ms / step_total)), 80)
    steps: List[Dict[str, Any]] = []
    for index in range(step_total):
        start_ratio = index / step_total
        end_ratio = (index + 1) / step_total
        steps.append(
            {
                "x1": int(round(x1 + (x2 - x1) * start_ratio)),
                "y1": int(round(y1 + (y2 - y1) * start_ratio)),
                "x2": int(round(x1 + (x2 - x1) * end_ratio)),
                "y2": int(round(y1 + (y2 - y1) * end_ratio)),
                "duration_ms": step_duration,
                "wait_after_sec": step_wait,
            }
        )
    if steps:
        steps[-1]["x2"] = x2
        steps[-1]["y2"] = y2
    return steps


def append_frame_to_targets(image_path: Path, frame_targets: List[List[Path]]) -> None:
    for target in frame_targets:
        target.append(image_path)


def append_repeated_frame(image_path: Path, frame_targets: List[List[Path]], repeat_count: int) -> None:
    for _ in range(max(int(repeat_count), 1)):
        append_frame_to_targets(image_path, frame_targets)


def unique_paths(paths: List[Path]) -> List[Path]:
    seen: set[str] = set()
    unique: List[Path] = []
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def execute_action(ctx: CaptureContext, action: Dict[str, Any], fallback_label: str) -> Optional[Path]:
    action_type = str(action.get("type") or "").strip().lower()
    if action_type == "click":
        click(ctx, int(action["x"]), int(action["y"]), str(action.get("label") or fallback_label))
        sleep_and_record(ctx, float(action.get("wait_after_sec", 1.0)), "after-click")
        return None
    if action_type == "swipe":
        swipe(
            ctx,
            int(action["x1"]),
            int(action["y1"]),
            int(action["x2"]),
            int(action["y2"]),
            int(action.get("duration_ms", 500)),
            str(action.get("label") or fallback_label),
        )
        sleep_and_record(ctx, float(action.get("wait_after_sec", 1.0)), "after-swipe")
        return None
    if action_type == "key":
        key_event(ctx, str(action["key"]))
        sleep_and_record(ctx, float(action.get("wait_after_sec", 1.0)), "after-key")
        return None
    if action_type == "sleep":
        sleep_and_record(ctx, float(action.get("seconds", 1.0)), str(action.get("label") or fallback_label))
        return None
    if action_type == "screenshot":
        return capture_screenshot(ctx, str(action.get("label") or fallback_label))
    raise RuntimeError(f"不支持的 action.type: {action_type}")


def run_tab_capture(ctx: CaptureContext, tab: Dict[str, Any], all_screenshots: List[Path]) -> Dict[str, Any]:
    tab_name = safe_slug(str(tab.get("name") or "tab"), "tab")
    page_screenshots: List[Path] = []
    tap = resolve_runtime_tab_tap(ctx, tab_name, tab) if bool(tab.get("activate_via_tap", True)) else (tab.get("tap") or {})
    capture_index = 1
    tab_intro_hold_frames = max(int(tab.get("tab_intro_hold_frames", 4)), 1)
    if tap:
        click(ctx, int(tap["x"]), int(tap["y"]), tab_name)
        sleep_and_record(ctx, float(tab.get("wait_after_tap_sec", 1.0)), f"after-tab-{tab_name}")

    if tab.get("capture_before_scroll", True):
        first_frame = capture_screenshot(ctx, f"{tab_name}_{capture_index}")
        append_repeated_frame(first_frame, [all_screenshots, page_screenshots], tab_intro_hold_frames)
        capture_index += 1

    scroll_capture_steps = max(int(tab.get("scroll_capture_steps", 4)), 1)
    scrolls = tab.get("scrolls") or []
    runtime_scroll_detection = bool(tab.get("runtime_scroll_detection", False))
    if runtime_scroll_detection and len(scrolls) == 1:
        before_dump = capture_ui_dump(ctx, f"{tab_name}_precheck")
        before_state = analyze_scroll_runtime_state(before_dump)
        precheck_status, precheck_message = classify_runtime_precheck(before_state)
        ctx.record(
            "runtime-scroll-precheck",
            {
                "tab": tab_name,
                "status": precheck_status,
                "message": precheck_message,
                "state": before_state,
            },
        )
        if precheck_status == "page_not_scrollable":
            return {
                "tab_name": tab_name,
                "title": str(tab.get("title") or tab_name),
                "slot_index": int(tab.get("slot_index", 0)),
                "component_name": str(tab.get("component_name") or ""),
                "screenshots": page_screenshots,
            }

        max_runtime_scrolls = max(int(tab.get("max_runtime_scrolls", DEFAULT_MAX_RUNTIME_SCROLLS)), 1)
        base_scroll = scrolls[0]
        for scroll_index in range(1, max_runtime_scrolls + 1):
            capture_index = execute_scroll_round(
                ctx,
                tab_name,
                scroll_index,
                base_scroll,
                scroll_capture_steps,
                capture_index,
                [all_screenshots, page_screenshots],
            )
            after_dump = capture_ui_dump(ctx, f"{tab_name}_scroll_{scroll_index:02d}")
            after_state = analyze_scroll_runtime_state(after_dump)
            scroll_status, scroll_message = classify_runtime_scroll_transition(before_state, after_state)
            ctx.record(
                "runtime-scroll-check",
                {
                    "tab": tab_name,
                    "scroll_index": scroll_index,
                    "status": scroll_status,
                    "message": scroll_message,
                    "before_state": before_state,
                    "after_state": after_state,
                },
            )
            if scroll_status != "scroll_effective":
                break
            before_state = after_state
        return {
            "tab_name": tab_name,
            "title": str(tab.get("title") or tab_name),
            "slot_index": int(tab.get("slot_index", 0)),
            "component_name": str(tab.get("component_name") or ""),
            "screenshots": page_screenshots,
        }

    for scroll_index, scroll in enumerate(scrolls, start=1):
        capture_index = execute_scroll_round(
            ctx,
            tab_name,
            scroll_index,
            scroll,
            scroll_capture_steps,
            capture_index,
            [all_screenshots, page_screenshots],
        )
    return {
        "tab_name": tab_name,
        "title": str(tab.get("title") or tab_name),
        "slot_index": int(tab.get("slot_index", 0)),
        "component_name": str(tab.get("component_name") or ""),
        "screenshots": page_screenshots,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="用纯 hdc 安装 HarmonyOS HAP、切 tab、滚动截图并生成 MP4。")
    parser.add_argument("--workspace", default=str(APP_ROOT.parent / "harmony-pilot"), help="HarmonyOS 工程目录")
    parser.add_argument("--hap", default="", help="显式指定 hap 路径；不传则从 workspace 下自动找最新 hap")
    parser.add_argument("--target", default="", help="hdc target；多设备时建议显式传入")
    parser.add_argument("--bundle-name", default="", help="bundle name；用于安装后启动应用")
    parser.add_argument("--ability-name", default="", help="ability name；不传则读配置，再回退到 EntryAbility")
    parser.add_argument("--config", default="", help="可选的手工覆盖配置 JSON；默认自动从工程推断")
    parser.add_argument("--run-id", default="", help="remote-ui run id；传入后产物落到 data/artifacts/videos/<run_id>/")
    parser.add_argument("--output-dir", default="", help="显式指定输出目录；优先级高于 run-id")
    parser.add_argument("--video-name", default="demo.mp4", help="最终 MP4 文件名")
    parser.add_argument("--frame-ms", type=int, default=220, help="MP4 单帧时长，毫秒；建议 180-300")
    parser.add_argument("--skip-install", action="store_true", help="跳过 hap 安装")
    parser.add_argument("--skip-launch", action="store_true", help="跳过应用启动")
    parser.add_argument("--plan-only", action="store_true", help="只输出自动推断的 capture plan，不连接设备")
    return parser.parse_args()


def resolve_output_dir(args: argparse.Namespace) -> Path:
    if args.output_dir:
        return Path(args.output_dir).expanduser().resolve()
    if args.run_id:
        return (DEFAULT_VIDEO_ROOT / args.run_id).resolve()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return (DEFAULT_VIDEO_ROOT / f"manual-{timestamp}").resolve()


def resolve_video_name(args: argparse.Namespace) -> str:
    return str(args.video_name)


def main() -> int:
    args = parse_args()
    workspace = Path(args.workspace).expanduser().resolve()
    output_dir = resolve_output_dir(args)
    video_name = resolve_video_name(args)
    page_videos_dir = output_dir / "pages"
    screenshots_dir = output_dir / "screenshots"
    manifest_path = output_dir / "capture-manifest.json"
    generated_plan_path = output_dir / "generated-capture-plan.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    screenshots_dir.mkdir(parents=True, exist_ok=True)

    inferred_plan = infer_capture_plan(workspace)
    config_path = Path(args.config).expanduser().resolve() if args.config else None
    config = read_json(config_path) if config_path else inferred_plan
    if config_path:
        config.setdefault("bundle_name", inferred_plan.get("bundle_name", ""))
        config.setdefault("ability_name", inferred_plan.get("ability_name", "EntryAbility"))
        config.setdefault("tabs", inferred_plan.get("tabs", []))
        config.setdefault("post_install_wait_sec", inferred_plan.get("post_install_wait_sec", 2.0))
        config.setdefault("post_launch_wait_sec", inferred_plan.get("post_launch_wait_sec", 3.0))
        config.setdefault("pre_actions", inferred_plan.get("pre_actions", []))
        config.setdefault("post_actions", inferred_plan.get("post_actions", []))
    write_json(generated_plan_path, config)

    if args.plan_only:
        print(json.dumps({"ok": True, "plan_path": str(generated_plan_path), "plan": config}, ensure_ascii=False, indent=2))
        return 0

    hdc_bin = resolve_hdc_binary()
    target = resolve_target(hdc_bin, args.target)
    hap_path = Path(args.hap).expanduser().resolve() if args.hap else find_latest_hap(workspace)
    bundle_name = args.bundle_name or str(config.get("bundle_name") or config.get("launch", {}).get("bundle_name") or "")
    ability_name = args.ability_name or str(config.get("ability_name") or config.get("launch", {}).get("ability_name") or "EntryAbility")

    manifest: Dict[str, Any] = {
        "started_at": now_iso(),
        "workspace": str(workspace),
        "hap_path": str(hap_path),
        "target": target,
        "hdc_bin": hdc_bin,
        "config_path": str(config_path) if config_path else "",
        "generated_plan_path": str(generated_plan_path),
        "output_dir": str(output_dir),
        "screenshots_dir": str(screenshots_dir),
        "page_videos_dir": str(page_videos_dir),
        "video_path": str(output_dir / video_name),
        "run_id": args.run_id or "",
        "bundle_name": bundle_name,
        "ability_name": ability_name,
        "video_name": video_name,
        "frame_ms": args.frame_ms,
        "steps": [],
        "screenshots": [],
        "page_videos": [],
    }
    ctx = CaptureContext(
        hdc_bin=hdc_bin,
        target=target,
        output_dir=output_dir,
        screenshots_dir=screenshots_dir,
        manifest_path=manifest_path,
        remote_tmp_dir=str(config.get("remote_tmp_dir") or DEFAULT_REMOTE_TMP_DIR),
        manifest=manifest,
    )
    write_json(manifest_path, manifest)

    all_screenshots: List[Path] = []
    page_captures: List[Dict[str, Any]] = []
    try:
        ensure_remote_tmp_dir(ctx)
        if not args.skip_install:
            install_hap(ctx, hap_path, bundle_name)
            sleep_and_record(ctx, float(config.get("post_install_wait_sec", 2.0)), "after-install")
        if bundle_name and not args.skip_launch:
            launch_app(ctx, bundle_name, ability_name)
            sleep_and_record(ctx, float(config.get("post_launch_wait_sec", 3.0)), "after-launch")

        bootstrap_path = capture_screenshot(ctx, "bootstrap_0")
        screen_width, screen_height = read_screen_size(bootstrap_path)
        config = apply_geometry_to_plan(config, screen_width, screen_height)
        write_json(generated_plan_path, config)
        ctx.manifest["screen"] = {"width": screen_width, "height": screen_height}
        ctx.manifest["generated_plan_path"] = str(generated_plan_path)
        write_json(manifest_path, ctx.manifest)

        for action_index, action in enumerate(config.get("pre_actions") or [], start=1):
            maybe_path = execute_action(ctx, action, f"pre-{action_index}")
            if maybe_path:
                all_screenshots.append(maybe_path)

        for tab in config.get("tabs") or []:
            page_captures.append(run_tab_capture(ctx, tab, all_screenshots))

        for action_index, action in enumerate(config.get("post_actions") or [], start=1):
            maybe_path = execute_action(ctx, action, f"post-{action_index}")
            if maybe_path:
                all_screenshots.append(maybe_path)

        video_path = output_dir / video_name
        build_mp4_with_ffmpeg(all_screenshots, video_path, args.frame_ms)
        page_videos: List[Dict[str, Any]] = []
        for page_capture in page_captures:
            page_screenshots = list(page_capture.get("screenshots") or [])
            if not page_screenshots:
                continue
            page_videos_dir.mkdir(parents=True, exist_ok=True)
            slot_index = int(page_capture.get("slot_index", 0))
            tab_name = safe_slug(str(page_capture.get("tab_name") or "page"), "page")
            page_video_path = page_videos_dir / f"{slot_index:02d}-{tab_name}.mp4"
            build_mp4_with_ffmpeg(page_screenshots, page_video_path, args.frame_ms)
            unique_page_screenshots = unique_paths(page_screenshots)
            page_videos.append(
                {
                    "tab_name": tab_name,
                    "title": str(page_capture.get("title") or tab_name),
                    "slot_index": slot_index,
                    "component_name": str(page_capture.get("component_name") or ""),
                    "video_path": str(page_video_path),
                    "video_size_bytes": page_video_path.stat().st_size if page_video_path.exists() else 0,
                    "screenshots": [str(item) for item in page_screenshots],
                    "unique_screenshots": [str(item) for item in unique_page_screenshots],
                    "rendered_frame_count": len(page_screenshots),
                    "unique_screenshot_count": len(unique_page_screenshots),
                }
            )
        unique_screenshot_paths = unique_paths(all_screenshots)
        ctx.manifest["completed_at"] = now_iso()
        ctx.manifest["status"] = "complete"
        ctx.manifest["screenshots"] = [str(item) for item in all_screenshots]
        ctx.manifest["unique_screenshots"] = [str(item) for item in unique_screenshot_paths]
        ctx.manifest["rendered_frame_count"] = len(all_screenshots)
        ctx.manifest["unique_screenshot_count"] = len(unique_screenshot_paths)
        ctx.manifest["video_path"] = str(video_path)
        ctx.manifest["video_size_bytes"] = video_path.stat().st_size if video_path.exists() else 0
        ctx.manifest["page_videos"] = page_videos
        write_json(manifest_path, ctx.manifest)
        print(
            json.dumps(
                {
                    "ok": True,
                    "video_path": str(video_path),
                    "page_videos": page_videos,
                    "manifest_path": str(manifest_path),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:  # pragma: no cover
        ctx.manifest["completed_at"] = now_iso()
        ctx.manifest["status"] = "failed"
        ctx.manifest["error"] = str(exc)
        ctx.manifest["screenshots"] = [str(item) for item in all_screenshots]
        write_json(manifest_path, ctx.manifest)
        print(json.dumps({"ok": False, "error": str(exc), "manifest_path": str(manifest_path)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
