// 灵感库示例模板。
//
// 这里的 previewHtml 是「后端已生成的 Web 产物」的占位实现：真实接入后应改为
// 从 /api/gallery 拉取，并把 previewHtml 换成产物 URL（与 RunArtifacts.web_url
// 同一套 iframe 通路）。字段命名刻意与 RunSummary / CreateRunRequest 对齐，
// 便于后端就位时直接替换数据源而不改组件。

import type { RunRuntime } from "./types"

export type GalleryCategory = "效率" | "生活" | "健康" | "学习" | "娱乐" | "AI"

export interface GalleryTemplate {
  id: string
  title: string
  tagline: string
  description: string
  category: GalleryCategory
  tags: string[]
  /** 生成该模板的原始创意描述，续跑时作为起点。 */
  prompt: string
  runtime: RunRuntime
  /** 后端预存工程的 run_id；续跑时由后端 fork 该工作区。 */
  sourceRunId: string
  author: string
  /** 被续跑的次数。 */
  remixes: number
  /** 首版生成耗时（分钟）。 */
  buildMinutes: number
  createdAt: string
  featured?: boolean
  /** 预览画布尺寸，与产物自身的设计宽高一致。 */
  canvasWidth: number
  canvasHeight: number
  previewHtml: string
}

const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
.bar{display:flex;align-items:center;justify-content:space-between;padding:14px 22px 2px;font-size:13px;letter-spacing:.02em}
.dots{display:flex;gap:4px;align-items:center}
.dots i{width:4px;height:4px;border-radius:50%;background:currentColor;display:block}
`

const POMODORO = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:#0d1220;color:#e8ecf6}
.bar{color:#6b7690}
main{padding:26px 26px 0;display:flex;flex-direction:column;height:calc(100% - 34px)}
h1{font-size:22px;font-weight:600;letter-spacing:-.01em}
.sub{margin-top:6px;font-size:13px;color:#6b7690}
.ring{margin:34px auto 0;position:relative;width:236px;height:236px}
.ring svg{transform:rotate(-90deg)}
.time{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.time b{font-size:52px;font-weight:300;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.time span{margin-top:2px;font-size:12px;color:#6b7690;letter-spacing:.14em}
.acts{display:flex;gap:12px;margin-top:32px}
.btn{flex:1;height:50px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:15px;border:0}
.primary{background:#ff6b4a;color:#fff}
.ghost{background:#182034;color:#9aa5bd}
.seg{margin-top:26px;display:flex;gap:8px}
.chip{flex:1;text-align:center;padding:9px 0;border-radius:11px;font-size:12px;background:#151d2e;color:#6b7690}
.chip.on{background:#222c44;color:#ff8f76}
.list{margin-top:24px;border-top:1px solid #1a2334;padding-top:16px}
.row{display:flex;align-items:center;gap:12px;padding:9px 0}
.row i{width:6px;height:6px;border-radius:50%;background:#ff6b4a;display:block;flex:none}
.row p{flex:1;font-size:13px;color:#c3cade}
.row span{font-size:12px;color:#5b6478;font-variant-numeric:tabular-nums}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<h1>专注一下</h1><p class="sub">今天已完成 3 个番茄 · 75 分钟</p>
<div class="ring">
<svg width="236" height="236"><circle cx="118" cy="118" r="104" fill="none" stroke="#1a2334" stroke-width="12"/>
<circle cx="118" cy="118" r="104" fill="none" stroke="#ff6b4a" stroke-width="12" stroke-linecap="round" stroke-dasharray="653" stroke-dashoffset="180"/></svg>
<div class="time"><b>18:24</b><span>专注中</span></div>
</div>
<div class="seg"><div class="chip on">专注 25</div><div class="chip">短憩 5</div><div class="chip">长憩 15</div></div>
<div class="acts"><button class="btn ghost">重置</button><button class="btn primary">暂停</button></div>
<div class="list">
<div class="row"><i></i><p>整理产品需求文档</p><span>25:00</span></div>
<div class="row"><i></i><p>回复邮件</p><span>25:00</span></div>
</div>
</main></body></html>`

const TODO = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:#f6f5f1;color:#1c1b18}
.bar{color:#9c988c}
main{padding:22px 24px 0}
.top{display:flex;align-items:flex-end;justify-content:space-between}
h1{font-size:26px;font-weight:600;letter-spacing:-.02em}
.date{font-size:12px;color:#9c988c;margin-top:4px}
.pct{text-align:right}
.pct b{font-size:24px;font-weight:400;color:#2f7d5d}
.pct span{display:block;font-size:11px;color:#9c988c}
.track{margin-top:16px;height:5px;border-radius:99px;background:#e6e3da;overflow:hidden}
.track i{display:block;height:100%;width:62%;background:#2f7d5d;border-radius:99px}
.group{margin-top:26px}
.gt{font-size:11px;letter-spacing:.14em;color:#9c988c;margin-bottom:10px}
.item{display:flex;align-items:center;gap:13px;background:#fff;border:1px solid #eae7de;border-radius:14px;padding:14px 15px;margin-bottom:9px}
.box{width:20px;height:20px;border-radius:6px;border:1.5px solid #cfcabb;flex:none}
.box.on{background:#2f7d5d;border-color:#2f7d5d;position:relative}
.box.on::after{content:"";position:absolute;left:6px;top:3px;width:6px;height:10px;border:2px solid #fff;border-top:0;border-left:0;transform:rotate(40deg)}
.item p{flex:1;font-size:14px}
.item.done p{color:#a8a49a;text-decoration:line-through}
.tag{font-size:11px;padding:3px 8px;border-radius:7px;background:#f1efe8;color:#8a8578}
.add{position:absolute;left:24px;right:24px;bottom:26px;height:52px;border-radius:16px;background:#1c1b18;color:#fff;display:flex;align-items:center;justify-content:center;gap:8px;font-size:15px}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<div class="top"><div><h1>今日待办</h1><p class="date">10月24日 星期四</p></div>
<div class="pct"><b>5/8</b><span>已完成</span></div></div>
<div class="track"><i></i></div>
<div class="group"><p class="gt">上午</p>
<div class="item done"><span class="box on"></span><p>晨会同步进度</p><span class="tag">工作</span></div>
<div class="item done"><span class="box on"></span><p>提交周报</p><span class="tag">工作</span></div>
<div class="item"><span class="box"></span><p>评审设计稿</p><span class="tag">工作</span></div>
</div>
<div class="group"><p class="gt">下午</p>
<div class="item"><span class="box"></span><p>买菜与晚餐食材</p><span class="tag">生活</span></div>
<div class="item"><span class="box"></span><p>健身 40 分钟</p><span class="tag">健康</span></div>
</div>
</main>
<div class="add">+ 新建待办</div>
</body></html>`

const LEDGER = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:#0b0b0d;color:#f2f2f4}
.bar{color:#6a6a73}
main{padding:22px 22px 0}
.hd{display:flex;align-items:center;justify-content:space-between}
h1{font-size:15px;font-weight:500;color:#a1a1ab}
.mo{font-size:12px;color:#6a6a73;background:#17171b;padding:5px 11px;border-radius:9px}
.amt{margin-top:18px}
.amt span{font-size:12px;color:#6a6a73}
.amt b{display:block;margin-top:5px;font-size:38px;font-weight:300;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.delta{display:inline-flex;align-items:center;gap:5px;margin-top:9px;font-size:12px;color:#4ade80;background:rgba(74,222,128,.1);padding:4px 9px;border-radius:8px}
.chart{margin-top:24px;display:flex;align-items:flex-end;gap:9px;height:104px}
.col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:7px;align-items:center}
.col i{width:100%;border-radius:6px 6px 3px 3px;background:#26262c;display:block}
.col.on i{background:#ffb03a}
.col span{font-size:10px;color:#5c5c66}
.sec{margin-top:26px;display:flex;align-items:center;justify-content:space-between}
.sec p{font-size:11px;letter-spacing:.14em;color:#6a6a73}
.sec a{font-size:12px;color:#ffb03a;text-decoration:none}
.tx{display:flex;align-items:center;gap:13px;padding:13px 0;border-bottom:1px solid #17171b}
.ic{width:36px;height:36px;border-radius:11px;background:#17171b;display:flex;align-items:center;justify-content:center;font-size:15px;flex:none}
.tx div{flex:1}
.tx b{display:block;font-size:14px;font-weight:400}
.tx small{font-size:11px;color:#6a6a73}
.tx span{font-size:15px;font-weight:300;font-variant-numeric:tabular-nums}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<div class="hd"><h1>本月支出</h1><span class="mo">10月 ›</span></div>
<div class="amt"><span>已花费</span><b>¥4,286</b><div class="delta">↓ 比上月少 12%</div></div>
<div class="chart">
<div class="col"><i style="height:38%"></i><span>五</span></div>
<div class="col"><i style="height:64%"></i><span>六</span></div>
<div class="col"><i style="height:29%"></i><span>日</span></div>
<div class="col"><i style="height:52%"></i><span>一</span></div>
<div class="col"><i style="height:71%"></i><span>二</span></div>
<div class="col on"><i style="height:88%"></i><span>三</span></div>
<div class="col"><i style="height:45%"></i><span>四</span></div>
</div>
<div class="sec"><p>近期账目</p><a href="#">全部</a></div>
<div class="tx"><span class="ic">🍜</span><div><b>午餐 · 面馆</b><small>今天 12:20</small></div><span>-38</span></div>
<div class="tx"><span class="ic">🚇</span><div><b>地铁通勤</b><small>今天 09:05</small></div><span>-6</span></div>
<div class="tx"><span class="ic">☕</span><div><b>咖啡</b><small>昨天 15:40</small></div><span>-22</span></div>
<div class="tx"><span class="ic">🛒</span><div><b>超市采购</b><small>昨天 19:10</small></div><span>-164</span></div>
</main></body></html>`

const FITNESS = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:#07120e;color:#e6f2ec}
.bar{color:#5d7a6e}
main{padding:22px 24px 0}
h1{font-size:24px;font-weight:600;letter-spacing:-.02em}
.sub{margin-top:5px;font-size:13px;color:#5d7a6e}
.week{margin-top:22px;display:flex;gap:7px}
.d{flex:1;text-align:center;padding:11px 0 9px;border-radius:12px;background:#0e1f18}
.d span{display:block;font-size:10px;color:#5d7a6e}
.d b{display:block;margin-top:6px;width:7px;height:7px;border-radius:50%;background:#1d3a2e;margin-inline:auto}
.d.ok b{background:#3ddc97}
.d.on{background:#123026}
.d.on span{color:#3ddc97}
.rings{margin-top:26px;display:flex;align-items:center;gap:22px;background:#0e1f18;border-radius:20px;padding:22px}
.rw{position:relative;width:118px;height:118px;flex:none}
.rw svg{transform:rotate(-90deg)}
.rc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.rc b{font-size:26px;font-weight:300}
.rc span{font-size:10px;color:#5d7a6e}
.stats{flex:1;display:flex;flex-direction:column;gap:14px}
.st span{font-size:11px;color:#5d7a6e}
.st b{display:block;font-size:19px;font-weight:300;margin-top:2px}
.sec{margin-top:24px;font-size:11px;letter-spacing:.14em;color:#5d7a6e}
.card{margin-top:12px;display:flex;align-items:center;gap:14px;background:#0e1f18;border-radius:15px;padding:15px}
.ci{width:40px;height:40px;border-radius:12px;background:#123026;display:flex;align-items:center;justify-content:center;font-size:17px;flex:none}
.card div{flex:1}
.card b{display:block;font-size:14px;font-weight:400}
.card small{font-size:11px;color:#5d7a6e}
.card span{font-size:12px;color:#3ddc97}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<h1>本周训练</h1><p class="sub">连续打卡 12 天，保持得不错</p>
<div class="week">
<div class="d ok"><span>一</span><b></b></div><div class="d ok"><span>二</span><b></b></div>
<div class="d ok"><span>三</span><b></b></div><div class="d"><span>四</span><b></b></div>
<div class="d ok"><span>五</span><b></b></div><div class="d on ok"><span>六</span><b></b></div>
<div class="d"><span>日</span><b></b></div>
</div>
<div class="rings">
<div class="rw"><svg width="118" height="118">
<circle cx="59" cy="59" r="50" fill="none" stroke="#123026" stroke-width="9"/>
<circle cx="59" cy="59" r="50" fill="none" stroke="#3ddc97" stroke-width="9" stroke-linecap="round" stroke-dasharray="314" stroke-dashoffset="72"/></svg>
<div class="rc"><b>77%</b><span>周目标</span></div></div>
<div class="stats">
<div class="st"><span>本周时长</span><b>4h 12m</b></div>
<div class="st"><span>消耗</span><b>2,860 kcal</b></div>
</div>
</div>
<p class="sec">今日计划</p>
<div class="card"><span class="ci">🏃</span><div><b>有氧跑步</b><small>30 分钟 · 中等强度</small></div><span>已完成</span></div>
<div class="card"><span class="ci">🧘</span><div><b>核心训练</b><small>4 组 · 腹部</small></div><span>待开始</span></div>
</main></body></html>`

const WEATHER = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:linear-gradient(170deg,#1b3a5c 0%,#123049 46%,#0c1f30 100%);color:#eaf2fa}
.bar{color:#8ba6bf}
main{padding:26px 26px 0;text-align:center}
.city{font-size:19px;font-weight:500}
.now{margin-top:2px;font-size:12px;color:#8ba6bf}
.tmp{margin-top:14px;font-size:76px;font-weight:200;letter-spacing:-.04em;line-height:1}
.cond{margin-top:4px;font-size:14px;color:#c3d6e8}
.hl{margin-top:6px;font-size:13px;color:#8ba6bf}
.hours{margin-top:28px;display:flex;gap:6px;background:rgba(255,255,255,.06);border-radius:18px;padding:15px 10px}
.h{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px}
.h span{font-size:11px;color:#8ba6bf}
.h i{font-size:17px;font-style:normal}
.h b{font-size:14px;font-weight:400}
.h.on{background:rgba(255,255,255,.1);border-radius:12px;padding:6px 0}
.grid{margin-top:14px;display:flex;gap:12px}
.box{flex:1;background:rgba(255,255,255,.06);border-radius:16px;padding:15px;text-align:left}
.box span{font-size:11px;color:#8ba6bf}
.box b{display:block;margin-top:6px;font-size:22px;font-weight:300}
.box small{font-size:11px;color:#8ba6bf}
.days{margin-top:14px;background:rgba(255,255,255,.06);border-radius:18px;padding:6px 16px}
.dr{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.07)}
.dr:last-child{border:0}
.dr p{width:34px;text-align:left;font-size:13px;color:#c3d6e8}
.dr i{font-size:15px;font-style:normal;width:22px}
.dr .tr{flex:1;height:4px;border-radius:99px;background:rgba(255,255,255,.14);position:relative}
.dr .tr b{position:absolute;height:100%;border-radius:99px;background:linear-gradient(90deg,#67b8f0,#ffcf70)}
.dr span{font-size:12px;color:#8ba6bf;width:52px;text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<p class="city">深圳市 南山区</p><p class="now">刚刚更新</p>
<p class="tmp">24°</p><p class="cond">多云转晴</p><p class="hl">最高 28° · 最低 19°</p>
<div class="hours">
<div class="h on"><span>现在</span><i>⛅</i><b>24°</b></div>
<div class="h"><span>11时</span><i>☀️</i><b>26°</b></div>
<div class="h"><span>13时</span><i>☀️</i><b>28°</b></div>
<div class="h"><span>15时</span><i>⛅</i><b>27°</b></div>
<div class="h"><span>17时</span><i>🌤</i><b>25°</b></div>
<div class="h"><span>19时</span><i>🌙</i><b>22°</b></div>
</div>
<div class="grid">
<div class="box"><span>空气质量</span><b>42</b><small>优 · 适宜户外</small></div>
<div class="box"><span>体感温度</span><b>26°</b><small>湿度 68%</small></div>
</div>
<div class="days">
<div class="dr"><p>今天</p><i>⛅</i><div class="tr"><b style="left:18%;right:22%"></b></div><span>19° 28°</span></div>
<div class="dr"><p>周五</p><i>☀️</i><div class="tr"><b style="left:26%;right:12%"></b></div><span>21° 31°</span></div>
<div class="dr"><p>周六</p><i>🌧</i><div class="tr"><b style="left:10%;right:38%"></b></div><span>17° 24°</span></div>
<div class="dr"><p>周日</p><i>🌤</i><div class="tr"><b style="left:16%;right:28%"></b></div><span>18° 26°</span></div>
</div>
</main></body></html>`

const FLASHCARD = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:#f5f0e6;color:#2b2620}
.bar{color:#a49781}
main{padding:20px 24px 0;display:flex;flex-direction:column;height:calc(100% - 34px)}
.hd{display:flex;align-items:center;justify-content:space-between}
.hd b{font-size:14px;font-weight:500}
.hd span{font-size:12px;color:#a49781}
.track{margin-top:12px;height:4px;background:#e5dccb;border-radius:99px;overflow:hidden}
.track i{display:block;height:100%;width:45%;background:#c2703f;border-radius:99px}
.card{margin-top:22px;background:#fff;border:1px solid #e8e0d0;border-radius:22px;padding:32px 26px;text-align:center;box-shadow:0 8px 22px rgba(80,60,30,.06)}
.card .w{font-size:38px;font-weight:500;letter-spacing:-.02em}
.card .ph{margin-top:8px;font-size:14px;color:#a49781;font-family:ui-monospace,monospace}
.card .pos{display:inline-block;margin-top:16px;font-size:11px;padding:4px 10px;border-radius:8px;background:#f5efe3;color:#c2703f}
.card .mean{margin-top:16px;font-size:17px}
.card .ex{margin-top:14px;padding-top:14px;border-top:1px solid #f0e9db;font-size:13px;line-height:1.65;color:#6b6355;text-align:left}
.acts{margin-top:auto;margin-bottom:24px;display:flex;gap:11px}
.b{flex:1;height:52px;border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;border:0;font-size:14px}
.b small{font-size:10px;opacity:.65;margin-top:2px}
.no{background:#efe7d8;color:#8a7f6c}
.ok{background:#2b2620;color:#fff}
.stat{display:flex;gap:9px;margin-top:18px}
.s{flex:1;background:#fffdf8;border:1px solid #ece4d4;border-radius:13px;padding:11px;text-align:center}
.s b{display:block;font-size:18px;font-weight:400}
.s span{font-size:10px;color:#a49781}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<div class="hd"><b>雅思核心词汇</b><span>18 / 40</span></div>
<div class="track"><i></i></div>
<div class="card">
<p class="w">resilient</p><p class="ph">/rɪˈzɪliənt/</p><span class="pos">adj. 形容词</span>
<p class="mean">有韧性的；能快速恢复的</p>
<p class="ex">The city proved remarkably resilient after the earthquake, rebuilding within two years.<br><br>地震过后这座城市展现出惊人的韧性，两年内便完成重建。</p>
</div>
<div class="stat">
<div class="s"><b>18</b><span>已认识</span></div>
<div class="s"><b>5</b><span>模糊</span></div>
<div class="s"><b>17</b><span>待学</span></div>
</div>
<div class="acts"><button class="b no">模糊<small>3 天后再看</small></button><button class="b ok">认识<small>进入复习池</small></button></div>
</main></body></html>`

const MUSIC = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:#101012;color:#f0f0f2}
.bar{color:#6e6e78}
main{padding:18px 26px 0}
.nav{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#6e6e78}
.art{margin:22px auto 0;width:280px;height:280px;border-radius:22px;background:linear-gradient(145deg,#e0553c,#8d2f4f 58%,#3a2140);position:relative;overflow:hidden}
.art::after{content:"";position:absolute;inset:0;background:radial-gradient(60% 55% at 32% 26%,rgba(255,255,255,.26),transparent 68%)}
.art b{position:absolute;left:22px;bottom:20px;font-size:13px;font-weight:400;letter-spacing:.18em;color:rgba(255,255,255,.82)}
.meta{margin-top:24px}
.meta h1{font-size:22px;font-weight:500;letter-spacing:-.01em}
.meta p{margin-top:5px;font-size:14px;color:#8b8b96}
.pb{margin-top:22px}
.pb .tr{height:4px;border-radius:99px;background:#26262b;position:relative}
.pb .tr i{position:absolute;left:0;top:0;height:100%;width:42%;background:#f0f0f2;border-radius:99px}
.pb .tr i::after{content:"";position:absolute;right:-5px;top:-3px;width:10px;height:10px;border-radius:50%;background:#fff}
.pb .t{display:flex;justify-content:space-between;margin-top:9px;font-size:11px;color:#6e6e78;font-variant-numeric:tabular-nums}
.ctl{margin-top:18px;display:flex;align-items:center;justify-content:space-between}
.ctl span{font-size:22px;color:#8b8b96}
.play{width:64px;height:64px;border-radius:50%;background:#f0f0f2;color:#101012;display:flex;align-items:center;justify-content:center;font-size:22px}
.foot{margin-top:24px;display:flex;align-items:center;justify-content:space-between;padding-top:16px;border-top:1px solid #1e1e23;font-size:12px;color:#6e6e78}
.q{display:flex;align-items:center;gap:9px}
.q i{width:24px;height:24px;border-radius:6px;background:#26262b;display:block}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<div class="nav"><span>‹ 正在播放</span><span>⋯</span></div>
<div class="art"><b>WANDER</b></div>
<div class="meta"><h1>夜航西飞</h1><p>陈稚 · 单曲</p></div>
<div class="pb"><div class="tr"><i></i></div><div class="t"><span>1:48</span><span>-2:26</span></div></div>
<div class="ctl"><span>🔀</span><span>⏮</span><div class="play">⏸</div><span>⏭</span><span>🔁</span></div>
<div class="foot"><div class="q"><i></i><span>下一首 · 长夜灯火</span></div><span>队列</span></div>
</main></body></html>`

const OCR = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=390,initial-scale=1"><style>${BASE_CSS}
body{background:#0a0c10;color:#e9edf4}
.bar{color:#66707f}
main{padding:20px 22px 0}
.hd{display:flex;align-items:center;justify-content:space-between}
.hd b{font-size:16px;font-weight:500}
.hd span{font-size:12px;color:#4f8ef7}
.scan{margin-top:16px;position:relative;height:172px;border-radius:18px;background:#121620;border:1px solid #1d2330;overflow:hidden}
.scan .doc{position:absolute;left:26px;right:26px;top:30px;bottom:30px;border-radius:11px;background:linear-gradient(135deg,#2a3242,#1a202c)}
.scan .doc p{position:absolute;left:16px;height:6px;border-radius:99px;background:rgba(255,255,255,.18)}
.scan .ln{position:absolute;left:0;right:0;top:56%;height:2px;background:#4f8ef7;box-shadow:0 0 14px 2px rgba(79,142,247,.6)}
.corner{position:absolute;width:20px;height:20px;border:2px solid #4f8ef7}
.badge{position:absolute;right:12px;top:12px;font-size:10px;background:rgba(79,142,247,.16);color:#8fb6fb;padding:4px 9px;border-radius:7px}
.sec{margin-top:22px;display:flex;align-items:center;justify-content:space-between}
.sec p{font-size:11px;letter-spacing:.14em;color:#66707f}
.sec span{font-size:11px;color:#4ade80}
.f{margin-top:10px;background:#121620;border:1px solid #1d2330;border-radius:13px;padding:13px 15px;display:flex;align-items:center;gap:12px}
.f div{flex:1}
.f span{font-size:10px;color:#66707f;letter-spacing:.06em}
.f b{display:block;margin-top:3px;font-size:14px;font-weight:400}
.f i{font-size:14px;font-style:normal;color:#4f8ef7}
.acts{margin-top:20px;display:flex;gap:11px}
.btn{flex:1;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:14px;border:0}
.g{background:#161b26;color:#9aa5b8}
.p{background:#4f8ef7;color:#fff}
</style></head><body>
<div class="bar"><span>9:41</span><div class="dots"><i></i><i></i><i></i></div></div>
<main>
<div class="hd"><b>名片识别</b><span>历史</span></div>
<div class="scan">
<div class="doc">
<p style="top:20px;width:96px"></p><p style="top:38px;width:64px"></p>
<p style="top:66px;width:120px"></p><p style="top:84px;width:88px"></p><p style="top:102px;width:104px"></p>
</div>
<div class="ln"></div>
<span class="corner" style="left:14px;top:14px;border-right:0;border-bottom:0"></span>
<span class="corner" style="right:14px;top:14px;border-left:0;border-bottom:0"></span>
<span class="corner" style="left:14px;bottom:14px;border-right:0;border-top:0"></span>
<span class="corner" style="right:14px;bottom:14px;border-left:0;border-top:0"></span>
<span class="badge">识别中 92%</span>
</div>
<div class="sec"><p>识别结果</p><span>✓ 8 个字段</span></div>
<div class="f"><div><span>姓名</span><b>林见夏</b></div><i>✎</i></div>
<div class="f"><div><span>公司</span><b>启明智能科技有限公司</b></div><i>✎</i></div>
<div class="f"><div><span>职位</span><b>产品总监</b></div><i>✎</i></div>
<div class="f"><div><span>手机</span><b>138 0013 8000</b></div><i>✎</i></div>
<div class="f"><div><span>邮箱</span><b>lin.jx@qiming.tech</b></div><i>✎</i></div>
<div class="acts"><button class="btn g">重新拍摄</button><button class="btn p">存入通讯录</button></div>
</main></body></html>`

export const GALLERY_TEMPLATES: GalleryTemplate[] = [
  {
    id: "focus-timer",
    title: "专注番茄钟",
    tagline: "环形倒计时 + 专注记录",
    description:
      "以环形进度作为唯一视觉焦点的番茄钟。支持专注、短憩、长憩三档切换，完成的每个番茄会记入当日列表并累计时长。深色配色降低夜间使用时的屏幕干扰。",
    category: "效率",
    tags: ["计时器", "环形进度", "深色主题"],
    prompt: "实现一个番茄闹钟计时器，支持专注与休息循环及提示音，并记录当日完成的番茄数与累计时长",
    runtime: "expo",
    sourceRunId: "tpl-focus-timer-0417",
    author: "Genius 官方",
    remixes: 342,
    buildMinutes: 6,
    createdAt: "2025-04-17T10:20:00+08:00",
    featured: true,
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: POMODORO,
  },
  {
    id: "todo-light",
    title: "极简待办清单",
    tagline: "纸质感 + 分时段分组",
    description:
      "按上午、下午分组的待办清单，顶部用完成率进度条给出即时反馈。浅色纸质配色与绿色完成态形成克制的对比，适合作为效率类应用的起点。",
    category: "效率",
    tags: ["清单", "浅色主题", "进度反馈"],
    prompt: "实现一个简洁的待办清单应用，支持增删改与本地存储，按时间段分组并显示今日完成率",
    runtime: "expo",
    sourceRunId: "tpl-todo-light-0402",
    author: "Genius 官方",
    remixes: 517,
    buildMinutes: 4,
    createdAt: "2025-04-02T09:05:00+08:00",
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: TODO,
  },
  {
    id: "ledger",
    title: "月度记账本",
    tagline: "柱状趋势 + 流水明细",
    description:
      "把「这个月花了多少」放在第一屏最显眼的位置，下方七日柱状图给出短期趋势，再接流水明细。金额统一使用等宽数字，便于纵向比对。",
    category: "生活",
    tags: ["记账", "数据图表", "趋势"],
    prompt: "实现一个记账应用，支持记录收支、按月汇总，并用柱状图展示最近七天的支出趋势",
    runtime: "expo",
    sourceRunId: "tpl-ledger-0328",
    author: "Genius 官方",
    remixes: 289,
    buildMinutes: 8,
    createdAt: "2025-03-28T14:40:00+08:00",
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: LEDGER,
  },
  {
    id: "fitness",
    title: "健身周报打卡",
    tagline: "环形完成度 + 周视图",
    description:
      "一周打卡状态用七个圆点横向排开，配合环形完成度与时长、热量两项关键指标。今日计划以卡片列出，已完成项直接标注状态。",
    category: "健康",
    tags: ["打卡", "环形图", "周视图"],
    prompt: "实现一个健身打卡应用，展示本周训练完成情况、累计时长与消耗热量，并列出今日训练计划",
    runtime: "expo",
    sourceRunId: "tpl-fitness-0411",
    author: "Genius 官方",
    remixes: 196,
    buildMinutes: 7,
    createdAt: "2025-04-11T18:15:00+08:00",
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: FITNESS,
  },
  {
    id: "weather",
    title: "天气预报卡片",
    tagline: "渐变天空 + 逐时预报",
    description:
      "以当前温度为绝对主体的天气页。逐时预报横向滚动，下方补充空气质量与体感温度，再以温度区间条呈现未来四天的高低温跨度。",
    category: "生活",
    tags: ["天气", "渐变", "逐时预报"],
    prompt: "实现一个天气应用，展示当前天气、逐时预报、空气质量以及未来四天的温度区间",
    runtime: "expo",
    sourceRunId: "tpl-weather-0405",
    author: "Genius 官方",
    remixes: 431,
    buildMinutes: 5,
    createdAt: "2025-04-05T08:30:00+08:00",
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: WEATHER,
  },
  {
    id: "flashcard",
    title: "单词记忆卡",
    tagline: "认识 / 模糊 双按钮复习",
    description:
      "一屏只呈现一个词：释义、音标、词性与双语例句。底部「认识 / 模糊」两个按钮驱动间隔重复，按钮上直接标注下次出现时间，让复习逻辑对用户透明。",
    category: "学习",
    tags: ["间隔重复", "暖色主题", "卡片"],
    prompt: "实现一个单词记忆卡应用，支持间隔重复算法，展示音标、词性、双语例句与学习进度统计",
    runtime: "expo",
    sourceRunId: "tpl-flashcard-0419",
    author: "Genius 官方",
    remixes: 254,
    buildMinutes: 6,
    createdAt: "2025-04-19T20:00:00+08:00",
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: FLASHCARD,
  },
  {
    id: "music",
    title: "音乐播放器",
    tagline: "大封面 + 进度控制",
    description:
      "以 280 见方的封面作为视觉主体，下方依次是曲目信息、可拖动进度条与播放控制。底部预留下一首的队列入口，整体保持近黑底色以突出封面。",
    category: "娱乐",
    tags: ["播放器", "大封面", "深色主题"],
    prompt: "实现一个音乐播放器界面，支持播放控制、进度拖动、随机与循环模式，并展示播放队列",
    runtime: "expo",
    sourceRunId: "tpl-music-0330",
    author: "Genius 官方",
    remixes: 178,
    buildMinutes: 5,
    createdAt: "2025-03-30T21:25:00+08:00",
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: MUSIC,
  },
  {
    id: "card-ocr",
    title: "AI 名片识别",
    tagline: "扫描动效 + 字段校对",
    description:
      "扫描区用一条发光扫描线表达识别进行中，识别完成后逐字段列出结果，每项都可就地编辑再存入通讯录——把 AI 的不确定性交还用户确认。",
    category: "AI",
    tags: ["OCR", "扫描动效", "字段校对"],
    prompt: "实现一个 AI 名片识别应用，拍照后自动提取姓名、公司、职位、电话与邮箱，支持逐字段校对后存入通讯录",
    runtime: "expo",
    sourceRunId: "tpl-card-ocr-0422",
    author: "Genius 官方",
    remixes: 163,
    buildMinutes: 9,
    createdAt: "2025-04-22T11:50:00+08:00",
    canvasWidth: 390,
    canvasHeight: 844,
    previewHtml: OCR,
  },
]

export const GALLERY_CATEGORIES: GalleryCategory[] = ["效率", "生活", "健康", "学习", "娱乐", "AI"]

export function findTemplate(id: string): GalleryTemplate | undefined {
  return GALLERY_TEMPLATES.find((t) => t.id === id)
}
