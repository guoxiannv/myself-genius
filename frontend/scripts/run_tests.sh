#!/usr/bin/env sh
set -eu

# frontend 的唯一测试入口。脚本自己切到 frontend/，因此可以从仓库任何位置调用。
#
# 两条 lane 按「由谁执行」划分：
#   tests/python/   Python 标准库 unittest
#   tests/node/     node --test
#
# 跑测试不需要 .venv，也不需要 requirements.txt 里的运行时依赖；
# 唯一的第三方依赖见 requirements-test.txt（今天只有 Pillow），
# 该约束由 tests/python/test_dependency_contract.py 断言，不是靠文档维持。

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

PYTHON_LANE="tests/python"
NODE_LANE="tests/node"
PYTHON_BIN="${PYTHON_BIN:-python3}"

run_python=1
run_node=1

usage() {
  cat <<'USAGE'
用法: scripts/run_tests.sh [--python | --node]

  （无参数）  先跑清点守卫，再依次执行 Python 与 Node 两条 lane
  --python    只跑 Python lane
  --node      只跑 Node lane

环境变量:
  PYTHON_BIN  指定解释器，默认 python3
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --python) run_node=0 ;;
    --node) run_python=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- 清点守卫
# 两种静默失败必须在跑测试之前被拦住，因为它们都会「少跑测试还报绿」：
#   1. 测试文件不归任何 lane 管，于是没有任何命令会执行它；
#   2. Python 子目录缺 __init__.py，unittest discover 会跳过整个目录且不报警告。
guard() {
  failures=0

  for file in $(find tests -name '__pycache__' -prune -o -name 'test_*.py' -print | sort); do
    case "$file" in
      "$PYTHON_LANE"/*) ;;
      *)
        echo "[守卫] $file 不在 $PYTHON_LANE/ 下，没有任何入口会执行它" >&2
        failures=$((failures + 1))
        ;;
    esac
  done

  for file in $(find tests -name '__pycache__' -prune -o -name '*.test.mjs' -print | sort); do
    case "$file" in
      "$NODE_LANE"/*) ;;
      *)
        echo "[守卫] $file 不在 $NODE_LANE/ 下，没有任何入口会执行它" >&2
        failures=$((failures + 1))
        ;;
    esac
  done

  for file in $(find "$NODE_LANE" -name '__pycache__' -prune -o -name '*.mjs' -print | sort); do
    case "$file" in
      *.test.mjs) ;;
      *)
        echo "[守卫] $file 不以 .test.mjs 结尾，node --test 的匹配会漏掉它" >&2
        failures=$((failures + 1))
        ;;
    esac
  done

  for dir in tests $(find "$PYTHON_LANE" -name '__pycache__' -prune -o -type d -print | sort); do
    if [ ! -f "$dir/__init__.py" ]; then
      echo "[守卫] $dir/ 缺少 __init__.py，unittest discover 会静默跳过整个目录" >&2
      failures=$((failures + 1))
    fi
  done

  if [ "$failures" -ne 0 ]; then
    echo "[守卫] 发现 $failures 处问题，未执行任何测试" >&2
    return 1
  fi
  echo "[守卫] 测试文件全部归属明确"
}

guard

# ---------------------------------------------------------------- Python lane
python_status=0
if [ "$run_python" -eq 1 ]; then
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "找不到解释器 $PYTHON_BIN；可用 PYTHON_BIN=/path/to/python3 指定。" >&2
    exit 1
  fi
  if ! "$PYTHON_BIN" -c 'import PIL' >/dev/null 2>&1; then
    echo "$PYTHON_BIN 缺少 Pillow，这是跑测试唯一需要安装的第三方包。" >&2
    echo "  装它：  $PYTHON_BIN -m pip install -r requirements-test.txt" >&2
    echo "  或换一个已装好的解释器： PYTHON_BIN=python3.14 $0" >&2
    exit 1
  fi
  echo
  echo "== Python lane ($PYTHON_BIN, $PYTHON_LANE) =="
  python_log="$(mktemp)"
  python_status_file="$(mktemp)"
  # set -e 会让失败的命令直接终止管道左侧的子 shell，导致状态写不出来。
  set +e
  { "$PYTHON_BIN" -m unittest discover -s "$PYTHON_LANE" -t . 2>&1; echo $? > "$python_status_file"; } | tee "$python_log"
  set -e
  python_status="$(cat "$python_status_file")"
  python_summary="$(grep -E '^Ran [0-9]+ test' "$python_log" | tail -1)"
  rm -f "$python_log" "$python_status_file"
fi

# ------------------------------------------------------------------ Node lane
node_status=0
if [ "$run_node" -eq 1 ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "找不到 node，无法执行 $NODE_LANE 下的测试。" >&2
    exit 1
  fi
  echo
  echo "== Node lane (node, $NODE_LANE) =="
  node_log="$(mktemp)"
  node_status_file="$(mktemp)"
  set +e
  { node --test "$NODE_LANE"/*.test.mjs 2>&1; echo $? > "$node_status_file"; } | tee "$node_log"
  set -e
  node_status="$(cat "$node_status_file")"
  node_summary="$(grep -E '^. (tests|pass|fail) ' "$node_log" | tr '\n' ' ')"
  rm -f "$node_log" "$node_status_file"
fi

# -------------------------------------------------------------------- 汇总
echo
echo "== 汇总 =="
if [ "$run_python" -eq 1 ]; then
  echo "Python  ${python_summary:-无输出}"
fi
if [ "$run_node" -eq 1 ]; then
  echo "Node    ${node_summary:-无输出}"
fi

if [ "${python_status:-1}" -ne 0 ] || [ "${node_status:-1}" -ne 0 ]; then
  echo "结果: 失败" >&2
  exit 1
fi
echo "结果: 全部通过"
