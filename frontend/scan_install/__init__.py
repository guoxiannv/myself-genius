"""HPack 扫码直装 + Profile 池（从 app.py 抽出的业务模块）。

本包供 app.py 通过 `from scan_install.xxx import ...` 调用，不是独立服务。

模块一览
---------
config.py       读取 deploy/server.env / .env.local，暴露 HPack、Profile 池等配置
profile_pool.py Profile 池：acquire/release slot、注入 ARKPILOT_BUNDLE_NAME
hpack.py        HAP 检测 → HPack 签名 → 发布安装页 → store:// 直装链接
time_utils.py   ISO 时间 parse/format

app.py 仍负责：HTTP 路由、tmux 调度、hdc 预览采集、RunRecord 持久化。
"""
