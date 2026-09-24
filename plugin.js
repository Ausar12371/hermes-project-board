/**
 * 项目分类台 (Project Board) — Hermes Desktop runtime plugin
 * 安装位置: $HERMES_HOME/desktop-plugins/project-board/plugin.js
 *
 * 干什么
 *  - 把助手做过的每个项目摊成卡片，归到固定的六个分类里：
 *    网页 / 插件 / 程序 / 游戏 / 项目 / 杂活
 *  - 分类是写死的一套（不提供新建/改名/删除 —— 分类体系不再需要处理）
 *  - 归类三条通道：整卡拖拽到列 · 点卡片徽章弹窗直选 · AI 全自动分类
 *  - 选择模式：勾选想删的项目 → 只删选中的，没勾的留着
 *  - 批量添加：一行一个项目（名称 | 路径 | 标注），新增的可以直接让 AI 归类
 *  - 标注：每张卡一个备注框（即改即存）+ 星标 + 路径（点击复制）
 *  - 点「继续处理」= 新建会话 + 把这一个项目的上下文递过去，接着干
 *  - 搜索过滤 · 实时计数 · 导出/导入 JSON · 入口：侧边栏 / Ctrl+K / 状态栏
 *
 * 跨机器：只用网关 RPC（llm.oneshot / session.create / prompt.submit）+ 插件自己的
 * localStorage。没有本机路径、没有写死的模型名 —— 换台装了桌面端的机器，
 * 把整个文件夹拷进 desktop-plugins/ 就能用，AI 分类走那台机器自己的模型配置。
 */

import {
  Codicon,
  cn,
  host,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Tip,
  atom,
  useValue
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'project-board'
const KEY = 'board-v3'
// 「这台机器上自动分类过没有」的标记。改版本号 = 允许再自动跑一次
// （版本号变更 = 允许对本机数据再自动跑一次分类）
const FLAG_KEY = 'auto-classify-v3.1'
const KEY_V2 = 'board-v2'
const KEY_V1 = 'board-v1'
const UNFILED = null

/* ============================ 固定分类（唯一真源） ============================ */

// 六类写死在这里：列顺序 = 数组顺序。hint 是列头下那行小字，也喂给 AI 当分类说明。
const CATS = [
  { id: 'web', name: '网页', icon: 'globe', hint: '站点 · 网页作品' },
  { id: 'plugin', name: '插件', icon: 'extensions', hint: '桌面插件 · 软件扩展' },
  { id: 'app', name: '程序', icon: 'window', hint: '程序 · 脚本 · 服务' },
  { id: 'game', name: '游戏', icon: 'game', hint: '游戏相关的一切' },
  { id: 'project', name: '项目', icon: 'project', hint: '成体系的工程 / 交付' },
  { id: 'chore', name: '杂活', icon: 'tools', hint: '视频超清 · 问答 · 电脑问题 · 监测检测' }
]

const CAT_BY_ID = {}
const CAT_BY_NAME = {}

for (const c of CATS) {
  CAT_BY_ID[c.id] = c
  CAT_BY_NAME[c.name] = c
}

/* ============================ 小工具 ============================ */

// jsx() 手工调用太啰嗦，包一层：el('div', {className}, child1, child2)
// key 走 jsx 的第三参数（不是 spread 进来），React 就不会唠叨 key-in-spread
function el(tag, props) {
  const kids = Array.prototype.slice.call(arguments, 2)
  const p = {}
  let key

  if (props) {
    for (const k in props) {
      if (k === 'key') {
        key = props[k]
      } else {
        p[k] = props[k]
      }
    }
  }

  if (kids.length === 1) {
    p.children = kids[0]
  } else if (kids.length > 1) {
    p.children = kids
  }

  return key === undefined ? jsx(tag, p) : jsx(tag, p, key)
}

const uid = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const clone = o => JSON.parse(JSON.stringify(o))
const errText = e => (e && e.message ? e.message : String(e))

// 诊断日志：renderer 的 console 会进 desktop.log，排查插件行为时直接看那里
// （用 error 而不是 log/warn —— 实测只有 error 级会被主进程转发进日志）
function log() {
  try {
    console.error.apply(console, ['[project-board]'].concat(Array.prototype.slice.call(arguments)))
  } catch (e) {
    /* noop */
  }
}

function toast(message) {
  try {
    host.notify({ kind: 'info', message: message })
  } catch (e) {
    /* 通知失败不影响功能 */
  }
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
      toast('已复制：' + (text.length > 40 ? text.slice(0, 40) + '…' : text))

      return
    }
  } catch (e) {
    /* 落回下面的提示 */
  }

  toast('这个环境不给复制权限，手动框选吧')
}

/* ============================ 样式常量（全部走主题变量） ============================ */

const INPUT =
  'w-full rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) px-2 py-1 text-xs text-foreground outline-none focus:border-(--ui-accent)'
const BTN =
  'inline-flex shrink-0 items-center gap-1 rounded-md border border-(--ui-stroke-tertiary) px-2 py-1 text-xs text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'
const BTN_ON = 'border-(--ui-accent) text-foreground'
const ICONBTN =
  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'
const CARD =
  'group flex cursor-grab flex-col gap-1.5 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-2.5 transition-colors hover:bg-primary/[0.06] active:cursor-grabbing'
const CHIP =
  'inline-flex items-center gap-1 rounded border border-(--ui-stroke-tertiary) px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary)'

/* ============================ 初始清单 ============================ */

// [名称, 路径, 标注, 兜底分类id]
// 首次装载会先让 AI 全自动分类；AI 拿不到结果时，才用第四列兜底。
const SEED_ROWS = [
  // 初始清单：只在「全新安装、且本机从没有过数据」时用它铺底。
  // 这里是通用示例——装好后随便改、删、加。格式：[名称, 路径(可空), 标注(可空), 兜底分类]
  ['示例 · 我的网站', 'https://example.com', '站点 / 网页作品放「网页」列', 'web'],
  ['示例 · 小工具脚本', 'D:\\tools', '能反复运行的程序 → 「程序」列', 'app'],
  ['示例 · 临时杂活', '', '视频超清 / 答疑 / 修电脑 → 「杂活」列', 'chore']
]

// 名字 → 兜底分类（AI 不可用时用；不进数据，只做对比与回填）
const SEED_FALLBACK = {}

for (const row of SEED_ROWS) {
  if (CAT_BY_ID[row[3]]) SEED_FALLBACK[row[0]] = row[3]
}

function seedItems() {
  return SEED_ROWS.map((row, i) => ({
    id: 'seed-' + i,
    name: row[0],
    path: row[1] || '',
    note: row[2] || '',
    cat: UNFILED, // 先空着 —— 交给 AI 第一次全自动分类
    star: false
  }))
}

/* ============================ 数据层 ============================ */

const $board = atom(null)
let ctxRef = null

// 首次装载要不要自动跑一次 AI 分类：'all' 全量 / 'new' 只补未分类 / false 不跑
let autoClassifyMode = false
let autoClassifyDone = false

function normalize(data) {
  if (!Array.isArray(data.cats)) data.cats = []
  if (!Array.isArray(data.items)) data.items = []

  for (const it of data.items) {
    if (!it.id) it.id = uid('p')
    if (!it.name) it.name = '(未命名)'
    if (typeof it.path !== 'string') it.path = ''
    if (typeof it.note !== 'string') it.note = ''
    if (typeof it.star !== 'boolean') it.star = false
    if (it.cat && !CAT_BY_ID[it.cat]) it.cat = UNFILED
  }

  data.v = 3

  return data
}

// 这份清单是不是"内置兜底填的"（从没被手动调过）—— 是的话可以放心让 AI 重判
function fallbackFilled(b) {
  if (!b.items.length) return false

  for (const it of b.items) {
    const fb = SEED_FALLBACK[it.name]

    if (fb === undefined) return false // 用户自己加的项目 → 不算"没动过"
    if ((it.cat || null) !== fb) return false // 分类被改过 → 不算
  }

  return true
}

function persist(data) {
  try {
    if (ctxRef) ctxRef.storage.set(KEY, data)
  } catch (e) {
    toast('保存失败：存储写不进去')
  }
}

function boot(ctx) {
  ctxRef = ctx
  autoClassifyMode = false
  autoClassifyDone = false

  const readStored = k => {
    try {
      return ctx.storage.get(k, null)
    } catch (e) {
      return null
    }
  }

  const data = readStored(KEY)

  if (data && Array.isArray(data.items)) {
    const norm = normalize(data)
    const tried = readStored(FLAG_KEY)

    $board.set(norm)

    // 清单还是内置兜底那份（没人手动调过）+ 这台机器还没自动分类过 → 让 AI 判一次
    if (!tried && fallbackFilled(norm)) {
      autoClassifyMode = 'all'
      autoClassifyDone = false
    }

    log('boot: existing data', norm.items.length, 'items | flagTried=' + Boolean(tried),
      '| fallbackFilled=' + fallbackFilled(norm), '| autoMode=' + String(autoClassifyMode))

    return
  }

  // 旧版迁上来（v2 优先，v1 也认 —— 两版的分类 id 与 v3 相同，所以分类不丢）
  const legacy = readStored(KEY_V2) || readStored(KEY_V1)

  if (legacy && Array.isArray(legacy.items) && legacy.items.length) {
    const migrated = normalize(legacy)

    // 分类没被动过（每一项都还等于内置兜底）→ 首装顺便让 AI 重排一次
    let untouched = true

    for (const it of migrated.items) {
      const fb = SEED_FALLBACK[it.name]

      if (fb === undefined || fb !== (it.cat || null)) {
        untouched = false
        break
      }
    }

    autoClassifyMode = untouched ? 'all' : false
    autoClassifyDone = !untouched
    $board.set(migrated)
    persist(migrated)

    return
  }

  // 全新安装：清单只带名字/路径/标注，分类留给 AI 第一次全自动分类
  const fresh = normalize({ v: 3, cats: [], items: seedItems() })

  autoClassifyMode = 'all'
  autoClassifyDone = false
  $board.set(fresh)
  persist(fresh)
}

function commit(next) {
  $board.set(next)
  persist(next)
}

function withBoard(fn) {
  const b = $board.get()

  if (!b) {
    return
  }

  commit(fn(clone(b)))
}

const api = {
  addItem(item) {
    const created = {
      id: uid('p'),
      name: item.name,
      path: item.path || '',
      note: item.note || '',
      cat: item.cat || UNFILED,
      star: false
    }

    withBoard(b => {
      b.items.push(created)

      return b
    })

    return created.id
  },
  batchAdd(rows) {
    const made = rows.map(r => ({
      id: uid('p'),
      name: r.name,
      path: r.path || '',
      note: r.note || '',
      cat: UNFILED,
      star: false
    }))

    withBoard(b => {
      for (const m of made) b.items.push(m)

      return b
    })

    return made.map(m => m.id)
  },
  updItem(id, patch) {
    withBoard(b => {
      const it = b.items.find(x => x.id === id)

      if (it) {
        for (const k in patch) {
          it[k] = patch[k]
        }
      }

      return b
    })
  },
  delItem(id) {
    withBoard(b => {
      b.items = b.items.filter(x => x.id !== id)

      return b
    })
  },
  delItems(ids) {
    const n = ids.length

    withBoard(b => {
      b.items = b.items.filter(x => ids.indexOf(x.id) < 0)

      return b
    })

    return n
  },
  assign(ids, cat) {
    const list = Array.isArray(ids) ? ids : [ids]

    withBoard(b => {
      for (const it of b.items) {
        if (list.indexOf(it.id) >= 0) it.cat = cat && CAT_BY_ID[cat] ? cat : UNFILED
      }

      return b
    })
  },
  applyAssignments(map) {
    let n = 0

    withBoard(b => {
      for (const it of b.items) {
        const cat = map[it.id]

        if (cat && CAT_BY_ID[cat]) {
          it.cat = cat
          n++
        }
      }

      return b
    })

    return n
  },
  fillFallbackCats() {
    let n = 0

    withBoard(b => {
      for (const it of b.items) {
        if (!it.cat && SEED_FALLBACK[it.name]) {
          it.cat = SEED_FALLBACK[it.name]
          n++
        }
      }

      return b
    })

    return n
  },
  importJson(data) {
    commit(normalize(data))
    toast('导入完成：' + data.items.length + ' 个项目')
  },
  reset() {
    commit(normalize({ v: 3, cats: [], items: seedItems() }))
    toast('已恢复初始清单（等 AI 归类）')
  },
  clearAll() {
    commit(normalize({ v: 3, cats: [], items: [] }))
    toast('清单已清空')
  }
}

/* ============================ AI 分类 ============================ */

function promptHeader() {
  const lines = CATS.map(c => '- ' + c.name + '：' + c.hint)

  return (
    '你是项目归档助手。把用户列出的每个项目归到下面唯一的分类里，只能从这些名字里挑：\n' +
    lines.join('\n') +
    '\n\n判定顺序（从上往下，命中即停）：' +
    '\n1) 游戏相关的一切（游戏内脚本、启动器、游戏素材）→ 游戏' +
    '\n2) 有独立代码库、能反复运行的工具 / 程序 / 服务 → 程序' +
    '\n3) 交付物是网页 / 站点 → 网页；是桌面插件 / 软件扩展 → 插件' +
    '\n4) 由多个部件组成、成体系的工程或交付物 → 项目' +
    '\n5) 只有一次性或零散的事务（视频超清、答疑、修电脑、监测与检测脚本、数据迁移）才算 杂活' +
    '\n不要默认往「杂活」扔：不属于第 5 类的，必须往前四条里挑最贴近的一个。' +
    '\n\n只输出一个 JSON 对象，键是项目序号（从 1 开始，字符串），值是分类名。不要解释、不要 markdown 代码块。\n' +
    '形如：{"1":"网页","2":"杂活","3":"程序"}'
  )
}

// 文本 → { itemId: catId }：先按 JSON 解，解不动就按"序号 + 分类名"逐行扫
function parseAssignments(text, items) {
  const out = {}
  const raw = String(text || '')

  const brace = raw.match(/\{[\s\S]*\}/)

  if (brace) {
    try {
      const obj = JSON.parse(brace[0])

      for (const k in obj) {
        const idx = parseInt(k, 10) - 1
        const cat = CAT_BY_NAME[String(obj[k]).trim()]

        if (items[idx] && cat) out[items[idx].id] = cat.id
      }

      if (Object.keys(out).length) return out
    } catch (e) {
      /* 落到逐行扫 */
    }
  }

  const re = new RegExp('(\\d+)\\s*[:：=.\\-—>)]*\\s*(' + CATS.map(c => c.name).join('|') + ')', 'g')
  let m

  while ((m = re.exec(raw))) {
    const idx = parseInt(m[1], 10) - 1
    const cat = CAT_BY_NAME[m[2]]

    if (items[idx] && cat) out[items[idx].id] = cat.id
  }

  return out
}

// 让模型给这批项目分类。模型 = 当前会话的模型（若在会话里），否则那台机器配置的辅助模型
async function aiClassify(items) {
  if (!items.length) return {}

  const list = items
    .map((it, i) => i + 1 + '. ' + it.name + (it.path ? ' — ' + it.path : '') + (it.note ? ' — ' + it.note : ''))
    .join('\n')

  const params = {
    instructions: promptHeader(),
    input: '项目列表：\n' + list,
    max_tokens: 900,
    temperature: 0,
    task: 'title_generation'
  }

  let sid = null

  try {
    sid = host.state && host.state.activeSessionId ? host.state.activeSessionId.get() : null
  } catch (e) {
    sid = null
  }

  if (sid) params.session_id = sid

  let res = null

  try {
    res = await host.request('llm.oneshot', params)
  } catch (e) {
    if (sid) {
      // 会话模型这条路不通 → 退回那台机器配置的辅助模型
      delete params.session_id
      res = await host.request('llm.oneshot', params)
    } else {
      throw e
    }
  }

  return parseAssignments(res && res.text, items)
}

// 首次装载自动跑（重试 3 次，失败用内置兜底，绝不空转）
async function runAutoClassify(attempt) {
  if (autoClassifyDone) return

  const b = $board.get()

  if (!b) return

  const pending = autoClassifyMode === 'all' ? b.items.slice() : b.items.filter(it => !it.cat)

  log('runAutoClassify attempt', attempt, '| pending', pending.length)

  if (!pending.length) {
    autoClassifyDone = true

    return
  }

  try {
    const map = await aiClassify(pending)
    const n = api.applyAssignments(map)

    if (n > 0) {
      autoClassifyDone = true
      toast('AI 已自动归类 ' + n + ' 个项目 🐋')

      return
    }

    throw new Error('模型没给出可解析的分类')
  } catch (e) {
    if (attempt < 2) {
      setTimeout(() => runAutoClassify(attempt + 1), 6000)

      return
    }

    const filled = api.fillFallbackCats()

    autoClassifyDone = true
    toast(
      'AI 分类没成（' + errText(e) + '）' + (filled ? '，已用内置归类兜底 ' + filled + ' 个' : '，可以点「AI 分类」重试')
    )
  }
}

/* ============================ 开会话：点一下就跟助手接着干 ============================ */

// 只有长得像 Windows 盘符路径的才当新会话的工作区交出去（伪路径给了也没用）
function usableCwd(path) {
  if (!path) return ''
  if (path.indexOf('→') >= 0 || path.indexOf('…') >= 0) return ''

  return /^[A-Za-z]:[\\/]/.test(path) ? path : ''
}

function projectPrompt(item) {
  const cat = item.cat ? CAT_BY_ID[item.cat] : null
  const lines = ['【从项目分类台继续处理】', '项目：' + item.name]

  if (cat) lines.push('分类：' + cat.name)
  if (item.path) lines.push('路径：' + item.path)
  if (item.note) lines.push('现有标注：' + item.note)

  lines.push('')
  lines.push(
    '先核对这个项目现在的状态（需要的话看关键文件 / 目录 / 最近的产物或报告），然后告诉我它处于什么状态、下一步能做什么、建议怎么推进。我之前交代过要干什么就直接接着干，没交代就先把方案说给我听。'
  )

  return lines.join('\n')
}

function categoryPrompt(label, items) {
  const lines = ['【从项目分类台继续处理】', '分类：' + label + '（' + items.length + ' 个项目）', '']

  for (let i = 0; i < items.length; i++) {
    const it = items[i]

    lines.push(i + 1 + '. ' + it.name + (it.path ? ' — ' + it.path : '') + (it.note ? ' — ' + it.note : ''))
  }

  lines.push('')
  lines.push('请先核对这些项目各自的状态，告诉我哪些还活着、哪些可以收尾、哪些能合并推进，然后给下一步建议。我说要动哪个就直接动。')

  return lines.join('\n')
}

// create → 跳过去 → 把上下文递上
async function openProjectSession(promptText, title, cwd) {
  const params = { cols: 96, source: 'project-board', title: title }

  if (cwd) params.cwd = cwd

  const res = await host.request('session.create', params)
  const runtimeId = res && (res.session_id || res.id)
  const storedId = (res && res.stored_session_id) || runtimeId

  if (!runtimeId || !storedId) {
    throw new Error('session.create 没给会话 id')
  }

  host.navigate('/' + encodeURIComponent(storedId))
  await host.request('prompt.submit', { session_id: runtimeId, text: promptText })

  return storedId
}

/* ============================ 弹窗基座 ============================ */

function Modal(props) {
  return el(
    'div',
    {
      className: 'fixed inset-0 z-50 flex items-center justify-center p-6',
      style: { background: 'color-mix(in srgb, var(--ui-bg-chrome) 72%, transparent)' },
      onClick: props.onClose
    },
    el(
      'div',
      {
        className: cn(
          'flex max-h-full w-full flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-4 shadow-2xl',
          props.wide ? 'max-w-xl' : 'max-w-sm'
        ),
        onClick: e => {
          if (e && e.stopPropagation) e.stopPropagation()
        }
      },
      el(
        'div',
        { className: 'mb-3 flex items-center justify-between gap-2 text-sm font-medium' },
        el('span', null, props.title),
        el(
          'button',
          { className: ICONBTN, type: 'button', title: '关闭', onClick: props.onClose },
          el(Codicon, { name: 'close' })
        )
      ),
      el('div', { className: 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto' }, props.children)
    )
  )
}

function CatPicker(props) {
  const value = props.value
  const options = CATS.concat([
    { id: UNFILED, name: props.unfiledLabel || '待分类', icon: 'inbox', hint: '还没归类的' }
  ])

  return el(
    'div',
    { className: 'flex flex-wrap gap-1.5' },
    options.map(o =>
      el(
        'button',
        {
          key: o.id === UNFILED ? '__unfiled__' : o.id,
          className: cn(BTN, value === o.id ? BTN_ON : null),
          type: 'button',
          title: o.hint,
          onClick: () => props.onChange(o.id)
        },
        el(Codicon, { name: o.icon, size: '0.8rem' }),
        o.name
      )
    )
  )
}

/* ============================ 弹窗们 ============================ */

function AssignDialog(props) {
  const board = $board.get()
  const it = board.items.find(x => x.id === props.id)

  if (!it) {
    return null
  }

  return el(
    Modal,
    { title: '把「' + it.name + '」归到…', onClose: props.onClose },
    el(CatPicker, {
      value: it.cat || UNFILED,
      onChange: v => {
        api.assign([it.id], v)
        props.onClose()
      }
    })
  )
}

function AssignManyDialog(props) {
  return el(
    Modal,
    { title: '把选中的 ' + props.count + ' 个项目归到…', onClose: props.onClose },
    el(CatPicker, {
      value: undefined,
      onChange: v => {
        api.assign(props.ids, v)
        props.onClose()
      }
    })
  )
}

// 删除自己挑：先看清楚要删谁，再点确认
function DeleteDialog(props) {
  const board = $board.get()
  const picked = board.items.filter(it => props.ids.indexOf(it.id) >= 0)
  const [armed, setArmed] = useState(false)

  return el(
    Modal,
    { title: '删除选中的 ' + picked.length + ' 个项目？', onClose: props.onClose },
    el(
      'div',
      { className: 'flex flex-col gap-0.5 text-xs text-(--ui-text-secondary)' },
      picked.slice(0, 12).map(it => el('div', { key: it.id, className: 'truncate' }, '· ' + it.name)),
      picked.length > 12
        ? el('div', { className: 'text-(--ui-text-quaternary)' }, '…另外 ' + (picked.length - 12) + ' 个')
        : null
    ),
    el('div', { className: 'pt-1 text-[0.6875rem] text-(--ui-text-quaternary)' }, '没勾的不会被碰。删掉只影响这个清单，项目文件本身不动。'),
    el(
      'button',
      {
        className: cn(BTN, armed ? 'border-(--ui-accent) text-foreground' : ''),
        type: 'button',
        onClick: () => {
          if (!armed) {
            setArmed(true)

            return
          }

          api.delItems(props.ids)
          props.onDone(picked.length)
        }
      },
      el(Codicon, { name: 'trash' }),
      armed ? '再点一次：确认删除' : '删除这 ' + picked.length + ' 个'
    )
  )
}

// 让 AI 重新判断全部（会覆盖现有分类，备注/星标不动）
function AiConfirmDialog(props) {
  return el(
    Modal,
    { title: '让 AI 重新判断全部？', onClose: props.onClose },
    el(
      'div',
      { className: 'text-xs text-(--ui-text-secondary)' },
      '现在 ' + props.total + ' 个项目都已归类。重排会按 AI 的判断覆盖现有分类 —— 备注、星标和「上次的对话」都不动。'
    ),
    el(
      'div',
      { className: 'flex gap-1.5' },
      el(
        'button',
        { className: BTN, type: 'button', onClick: () => props.onAll() },
        el(Codicon, { name: 'sparkle' }),
        '全部重排'
      ),
      el('button', { className: BTN, type: 'button', onClick: props.onClose }, '算了')
    )
  )
}

function ItemDialog(props) {
  const board = $board.get()
  const editing = props.id ? board.items.find(x => x.id === props.id) : null
  const [name, setName] = useState(editing ? editing.name : '')
  const [path, setPath] = useState(editing ? editing.path : '')
  const [note, setNote] = useState(editing ? editing.note : '')
  const [cat, setCat] = useState(editing ? editing.cat || UNFILED : props.cat || UNFILED)

  const submit = () => {
    if (!name.trim()) return

    if (editing) {
      api.updItem(editing.id, { name: name.trim(), path: path.trim(), note: note, cat: cat })
    } else {
      api.addItem({ name: name.trim(), path: path.trim(), note: note, cat: cat })
    }

    props.onClose()
  }

  return el(
    Modal,
    { title: editing ? '编辑项目' : '新建项目', onClose: props.onClose },
    el('input', {
      autoFocus: true,
      className: INPUT,
      placeholder: '项目名称',
      value: name,
      onChange: e => setName(e.target.value),
      onKeyDown: e => {
        if (e.key === 'Enter') submit()
      }
    }),
    el('input', {
      className: INPUT,
      placeholder: '路径 / 链接（可空）',
      value: path,
      onChange: e => setPath(e.target.value)
    }),
    el('textarea', {
      className: INPUT,
      placeholder: '标注（可空）',
      rows: 3,
      value: note,
      onChange: e => setNote(e.target.value)
    }),
    el('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)' }, '归到哪一类：'),
    el(CatPicker, { value: cat, onChange: setCat }),
    el(
      'div',
      { className: 'flex gap-1.5' },
      el(
        'button',
        { className: BTN, type: 'button', onClick: submit },
        el(Codicon, { name: 'check' }),
        editing ? '保存' : '加入清单'
      ),
      editing
        ? el(
            'button',
            {
              className: BTN,
              type: 'button',
              onClick: () => {
                api.delItem(editing.id)
                props.onClose()
              }
            },
            el(Codicon, { name: 'trash' }),
            '只删这一个'
          )
        : null
    )
  )
}

function BulkAddDialog(props) {
  const [text, setText] = useState('')
  const [autoAi, setAutoAi] = useState(true)
  const [busy, setBusy] = useState(false)

  const rows = () =>
    text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split('|').map(s => s.trim())

        return { name: parts[0], path: parts[1] || '', note: parts.slice(2).join(' | ') || '' }
      })
      .filter(r => r.name)

  const submit = async () => {
    const list = rows()

    if (!list.length) return

    setBusy(true)

    try {
      const ids = api.batchAdd(list)
      toast('已加入 ' + ids.length + ' 个项目')

      if (autoAi) {
        const fresh = ($board.get().items || []).filter(it => ids.indexOf(it.id) >= 0)

        try {
          const map = await aiClassify(fresh)
          const n = api.applyAssignments(map)

          toast(n ? 'AI 顺手归类了 ' + n + ' 个' : 'AI 没给出结果，先都放「待分类」')
        } catch (e) {
          toast('AI 分类失败：' + errText(e))
        }
      }

      props.onClose()
    } finally {
      setBusy(false)
    }
  }

  return el(
    Modal,
    { title: '批量添加项目', wide: true, onClose: props.onClose },
    el(
      'div',
      { className: 'text-[0.6875rem] text-(--ui-text-quaternary)' },
      '一行一个项目。想带路径/标注就写「名称 | 路径 | 标注」（后两段可省）。'
    ),
    el('textarea', {
      autoFocus: true,
      className: INPUT,
      rows: 8,
      placeholder: '官网改版 | D:\\sites\\corp-site | 六月底上线\n爬虫脚本\n视频超清：DV 带修 4K',
      value: text,
      onChange: e => setText(e.target.value)
    }),
    el(
      'label',
      { className: 'flex items-center gap-1.5 text-[0.6875rem] text-(--ui-text-secondary)' },
      el('input', { type: 'checkbox', checked: autoAi, onChange: e => setAutoAi(e.target.checked) }),
      '加完立刻让 AI 归类'
    ),
    el(
      'div',
      { className: 'flex gap-1.5' },
      el(
        'button',
        {
          className: BTN,
          type: 'button',
          disabled: busy,
          style: busy ? { opacity: 0.6 } : null,
          onClick: submit
        },
        el(Codicon, { name: busy ? 'sync~spin' : 'check' }),
        busy ? '处理中…' : '加入 ' + rows().length + ' 个'
      ),
      el('div', { className: 'flex-1' }),
      el(
        'button',
        { className: BTN, type: 'button', onClick: () => setText('') },
        '清空输入'
      )
    )
  )
}

function IoDialog(props) {
  const board = $board.get()
  const text = JSON.stringify(board, null, 2)
  const [paste, setPaste] = useState('')
  const [armed, setArmed] = useState(false)
  const [armedClear, setArmedClear] = useState(false)

  const doImport = () => {
    try {
      const data = JSON.parse(paste)

      if (!data || !Array.isArray(data.items)) {
        toast('这段 JSON 里没有 items 数组，不对')

        return
      }

      api.importJson(data)
      props.onClose()
    } catch (e) {
      toast('JSON 解析失败，检查一下粘贴内容')
    }
  }

  return el(
    Modal,
    { title: '导出 / 导入', wide: true, onClose: props.onClose },
    el('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)' }, '当前数据（复制走吧，就是你的归类成果）：'),
    el('textarea', { className: INPUT, rows: 7, readOnly: true, value: text, onFocus: e => e.target.select() }),
    el(
      'div',
      { className: 'flex flex-wrap gap-1.5' },
      el(
        'button',
        { className: BTN, type: 'button', onClick: () => copyText(text) },
        el(Codicon, { name: 'copy' }),
        '复制全部'
      ),
      el(
        'button',
        {
          className: cn(BTN, armed ? 'border-(--ui-accent) text-foreground' : ''),
          type: 'button',
          onClick: () => {
            if (!armed) {
              setArmed(true)

              return
            }

            api.reset()
            props.onClose()
          }
        },
        el(Codicon, { name: 'history' }),
        armed ? '再点一次：恢复初始清单' : '恢复初始清单'
      ),
      el(
        'button',
        {
          className: cn(BTN, armedClear ? 'border-(--ui-accent) text-foreground' : ''),
          type: 'button',
          onClick: () => {
            if (!armedClear) {
              setArmedClear(true)

              return
            }

            api.clearAll()
            props.onClose()
          }
        },
        el(Codicon, { name: 'clear-all' }),
        armedClear ? '再点一次：清空全部' : '清空全部（从零开始）'
      )
    ),
    el('div', { className: 'pt-1 text-[0.6875rem] text-(--ui-text-quaternary)' }, '粘贴一段之前导出的 JSON，覆盖当前数据：'),
    el('textarea', {
      className: INPUT,
      placeholder: '{"v":3,"cats":[],"items":[…]}',
      rows: 4,
      value: paste,
      onChange: e => setPaste(e.target.value)
    }),
    el(
      'button',
      { className: BTN, type: 'button', onClick: doImport },
      el(Codicon, { name: 'cloud-upload' }),
      '导入并覆盖'
    )
  )
}

/* ============================ 卡片 ============================ */

function Card(props) {
  const it = props.item
  const cat = it.cat ? CAT_BY_ID[it.cat] : null

  return el(
    'div',
    {
      key: it.id,
      className: cn(
        CARD,
        props.dragging ? 'opacity-40' : null,
        props.selMode ? 'cursor-pointer' : null,
        props.selected ? 'border-(--ui-accent)' : null
      ),
      draggable: !props.selMode,
      onClick: props.selMode
        ? () => props.onToggle(it.id)
        : null,
      onDragStart: e => {
        try {
          e.dataTransfer.setData('text/plain', it.id)
          e.dataTransfer.effectAllowed = 'move'
        } catch (err) {
          /* 极端情况下 dl 不可用，仍走点击改归类通道 */
        }

        props.onDragStart(it.id)
      },
      onDragEnd: () => props.onDragEnd()
    },
    el(
      'div',
      { className: 'flex items-start gap-1' },
      props.selMode
        ? el(
            'span',
            {
              className: cn(
                'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                props.selected ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-tertiary)'
              )
            },
            props.selected ? el(Codicon, { name: 'check', size: '0.7rem' }) : null
          )
        : el(
            'button',
            {
              className: cn(ICONBTN, it.star ? 'text-(--ui-accent)' : null),
              type: 'button',
              title: it.star ? '取消星标' : '星标',
              onClick: () => props.onStar(it)
            },
            el(Codicon, { name: it.star ? 'star-full' : 'star-empty' })
          ),
      el('div', { className: 'min-w-0 flex-1 text-[0.8125rem] leading-snug font-medium' }, it.name),
      props.selMode
        ? null
        : el(
            'button',
            { className: ICONBTN, type: 'button', title: '编辑', onClick: () => props.onEdit(it) },
            el(Codicon, { name: 'edit' })
          )
    ),
    it.path
      ? el(
          'button',
          {
            className: 'truncate text-left text-[0.6875rem] text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
            type: 'button',
            title: '点击复制：' + it.path,
            onClick: e => {
              if (props.selMode) {
                if (e && e.stopPropagation) e.stopPropagation()

                return
              }

              copyText(it.path)
            }
          },
          it.path
        )
      : null,
    el(
      'div',
      { className: 'flex items-center gap-1.5' },
      el(
        'button',
        {
          className: CHIP + ' hover:text-foreground',
          type: 'button',
          title: '点击换个分类',
          onClick: e => {
            if (props.selMode) {
              if (e && e.stopPropagation) e.stopPropagation()

              return
            }

            props.onAssign(it)
          }
        },
        el(Codicon, { name: cat ? cat.icon : 'inbox' }),
        cat ? cat.name : '待分类'
      ),
      el('div', { className: 'flex-1' }),
      props.selMode
        ? null
        : el(
            'button',
            {
              className: cn(BTN, 'px-1.5 py-0.5'),
              type: 'button',
              title: '开一个新对话，带上这个项目的上下文接着干',
              disabled: Boolean(props.chatting),
              style: props.chatting ? { opacity: 0.6 } : null,
              onClick: () => props.onChat(it)
            },
            el(Codicon, { name: 'comment-discussion', size: '0.75rem' }),
            props.chatting ? '正在开…' : '继续处理'
          )
    ),
    it.sid && !props.selMode
      ? el(
          'button',
          {
            className:
              'self-start truncate text-left text-[0.625rem] text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
            type: 'button',
            title: '回到上次开的那个对话',
            onClick: () => host.navigate('/' + encodeURIComponent(it.sid))
          },
          '↩ 上次的对话'
        )
      : null,
    props.selMode
      ? null
      : el('textarea', {
          className:
            'w-full resize-none rounded border border-transparent bg-transparent text-[0.6875rem] leading-snug text-(--ui-text-secondary) outline-none placeholder:text-(--ui-text-quaternary) focus:border-(--ui-stroke-tertiary)',
          rows: 2,
          placeholder: '写点标注…',
          value: it.note,
          onDragStart: e => e.stopPropagation(),
          onChange: e => props.onNote(it, e.target.value)
        })
  )
}

/* ============================ 列 ============================ */

function Column(props) {
  const isUnfiled = props.catId === UNFILED
  const cat = isUnfiled ? null : CAT_BY_ID[props.catId]

  return el(
    'div',
    {
      className: cn(
        'flex h-full w-[250px] shrink-0 flex-col gap-2 rounded-lg border p-2',
        props.over ? 'border-(--ui-accent)' : 'border-(--ui-stroke-tertiary)',
        'bg-[color-mix(in_srgb,var(--ui-bg-quinary)_55%,transparent)]'
      ),
      onDragOver: e => {
        e.preventDefault()

        try {
          e.dataTransfer.dropEffect = 'move'
        } catch (err) {
          /* noop */
        }

        props.onOver(props.catId)
      },
      onDragLeave: () => props.onOver(null),
      onDrop: e => {
        e.preventDefault()
        props.onOver(null)

        let id = ''

        try {
          id = e.dataTransfer.getData('text/plain')
        } catch (err) {
          id = ''
        }

        if (id) props.onDropItem(id, props.catId)
      }
    },
    el(
      'div',
      { className: 'flex items-center gap-1.5' },
      el(Codicon, { name: isUnfiled ? 'inbox' : cat.icon, size: '0.8rem' }),
      el('span', { className: 'min-w-0 flex-1 truncate text-xs font-medium' }, isUnfiled ? '待分类' : cat.name),
      el('span', { className: 'text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)' }, String(props.count)),
      el(
        'button',
        {
          className: ICONBTN,
          type: 'button',
          title: '就这一类的活儿开个对话',
          disabled: Boolean(props.busy),
          style: props.busy ? { opacity: 0.5 } : null,
          onClick: () => props.onChatCat(props.catId)
        },
        el(Codicon, { name: 'comment-discussion' })
      ),
      el(
        'button',
        { className: ICONBTN, type: 'button', title: '往这一类里加新项目', onClick: () => props.onAddItem(props.catId) },
        el(Codicon, { name: 'add' })
      )
    ),
    el(
      'div',
      { className: 'truncate text-[0.625rem] text-(--ui-text-quaternary)' },
      isUnfiled ? '还没想好放哪儿的' : cat.hint
    ),
    el(
      'div',
      { className: 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5' },
      props.items.length
        ? props.items.map(it => el(Card, props.cardProps(it)))
        : el(
            'div',
            {
              className:
                'flex h-20 items-center justify-center rounded-md border border-dashed border-(--ui-stroke-tertiary) text-[0.6875rem] text-(--ui-text-quaternary)'
            },
            isUnfiled ? '全部归好类了 🎉' : '把卡片拖到这里'
          )
    )
  )
}

/* ============================ 页面 ============================ */

function Page() {
  const board = useValue($board)
  const [q, setQ] = useState('')
  const [over, setOver] = useState(null)
  const [dragId, setDragId] = useState(null)
  const [dlg, setDlg] = useState(null)
  const [busyChat, setBusyChat] = useState(null)
  const [selMode, setSelMode] = useState(false)
  const [sel, setSel] = useState([])
  const [classifying, setClassifying] = useState(false)

  if (!board) {
    return el('div', { className: 'p-6 text-sm text-(--ui-text-tertiary)' }, '正在读取…')
  }

  const kw = q.trim().toLowerCase()
  const hit = it => !kw || (it.name + ' ' + it.path + ' ' + it.note).toLowerCase().indexOf(kw) >= 0
  const unfiled = board.items.filter(it => !it.cat && hit(it))
  const counts = {}
  let filed = 0

  for (const it of board.items) {
    if (it.cat && CAT_BY_ID[it.cat]) {
      filed++
      counts[it.cat] = (counts[it.cat] || 0) + 1
    }
  }

  const visible = board.items.filter(hit)
  const allVisibleSelected = visible.length > 0 && visible.every(it => sel.indexOf(it.id) >= 0)

  const toggleSel = id => setSel(s => (s.indexOf(id) >= 0 ? s.filter(x => x !== id) : s.concat([id])))

  const exitSel = () => {
    setSelMode(false)
    setSel([])
  }

  // 点卡片「继续处理」：开一个新会话，把这一个项目的上下文递过去
  const startProjectChat = async it => {
    if (busyChat) return

    setBusyChat(it.id)

    try {
      const sid = await openProjectSession(projectPrompt(it), '项目 · ' + it.name, usableCwd(it.path))

      api.updItem(it.id, { sid: sid })
      toast('已开好对话：' + it.name)
    } catch (e) {
      toast('开会话失败：' + errText(e))
    } finally {
      setBusyChat(null)
    }
  }

  // 点列头小图标：就这一类的全部项目开一个会话
  const startCategoryChat = async catId => {
    if (busyChat) return

    const cat = catId ? CAT_BY_ID[catId] : null
    const label = cat ? cat.name : '待分类'
    const items = board.items.filter(it => (catId ? it.cat === catId : !it.cat))

    if (!items.length) {
      toast('「' + label + '」这一列还是空的')

      return
    }

    setBusyChat('__cat__' + (catId || 'unfiled'))

    try {
      await openProjectSession(categoryPrompt(label, items), '分类 · ' + label)
      toast('已开好对话：' + label + '（' + items.length + ' 个项目）')
    } catch (e) {
      toast('开会话失败：' + errText(e))
    } finally {
      setBusyChat(null)
    }
  }

  const runClassify = async list => {
    if (classifying || !list.length) return

    setClassifying(true)
    toast('AI 正在归类 ' + list.length + ' 个项目…')

    try {
      const map = await aiClassify(list)
      const n = api.applyAssignments(map)

      toast(n ? 'AI 归类完成：' + n + ' 个' : 'AI 没给出能解析的结果，再点一次试试')
    } catch (e) {
      toast('AI 分类失败：' + errText(e))
    } finally {
      setClassifying(false)
    }
  }

  // 手动让 AI 归类：优先补未归类的；全都归好了就问要不要整盘重排
  const classifyNow = () => {
    if (classifying) return

    if (!board.items.length) {
      toast('清单是空的，先用「批量添加」或「新建项目」加点货')

      return
    }

    const pending = board.items.filter(it => !it.cat)

    if (pending.length) {
      runClassify(pending)

      return
    }

    setDlg({ type: 'aiConfirm' })
  }

  const cardProps = it => ({
    key: it.id,
    item: it,
    dragging: dragId === it.id,
    chatting: busyChat === it.id,
    selMode: selMode,
    selected: sel.indexOf(it.id) >= 0,
    onToggle: toggleSel,
    onChat: startProjectChat,
    onDragStart: setId => setDragId(setId),
    onDragEnd: () => setDragId(null),
    onStar: x => api.updItem(x.id, { star: !x.star }),
    onEdit: x => setDlg({ type: 'item', id: x.id }),
    onAssign: x => setDlg({ type: 'assign', id: x.id }),
    onNote: (x, v) => api.updItem(x.id, { note: v })
  })

  const drop = (id, cat) => api.assign([id], cat)

  const columns = CATS.map(c =>
    el(Column, {
      key: c.id,
      catId: c.id,
      count: counts[c.id] || 0,
      over: over === c.id,
      items: board.items.filter(it => it.cat === c.id && hit(it)),
      busy: Boolean(busyChat),
      onOver: setOver,
      onDropItem: drop,
      onChatCat: startCategoryChat,
      onAddItem: catId => setDlg({ type: 'item', cat: catId }),
      cardProps: cardProps
    })
  )

  if (unfiled.length) {
    columns.unshift(
      el(Column, {
        key: '__unfiled__',
        catId: UNFILED,
        count: unfiled.length,
        over: over === '__unfiled__',
        items: unfiled,
        busy: Boolean(busyChat),
        onOver: setOver,
        onDropItem: drop,
        onChatCat: startCategoryChat,
        onAddItem: () => setDlg({ type: 'item' }),
        cardProps: cardProps
      })
    )
  }

  let dialog = null

  if (dlg && dlg.type === 'assign') {
    dialog = el(AssignDialog, { id: dlg.id, onClose: () => setDlg(null) })
  } else if (dlg && dlg.type === 'assignMany') {
    dialog = el(AssignManyDialog, { ids: sel, count: sel.length, onClose: () => setDlg(null) })
  } else if (dlg && dlg.type === 'aiConfirm') {
    dialog = el(AiConfirmDialog, {
      total: board.items.length,
      onClose: () => setDlg(null),
      onAll: () => {
        setDlg(null)
        runClassify(board.items.slice())
      }
    })
  } else if (dlg && dlg.type === 'deleteMany') {
    dialog = el(DeleteDialog, {
      ids: sel,
      onClose: () => setDlg(null),
      onDone: n => {
        setDlg(null)
        exitSel()
        toast('已删除 ' + n + ' 个项目')
      }
    })
  } else if (dlg && dlg.type === 'item') {
    dialog = el(ItemDialog, { id: dlg.id, cat: dlg.cat, onClose: () => setDlg(null) })
  } else if (dlg && dlg.type === 'bulkAdd') {
    dialog = el(BulkAddDialog, { onClose: () => setDlg(null) })
  } else if (dlg && dlg.type === 'io') {
    dialog = el(IoDialog, { onClose: () => setDlg(null) })
  }

  return el(
    'div',
    { className: 'flex h-full flex-col gap-3 p-4' },
    el(
      'div',
      { className: 'flex flex-wrap items-center gap-2' },
      el(Codicon, { name: 'project', size: '1rem' }),
      el('span', { className: 'text-sm font-medium' }, '项目分类台'),
      el('span', { className: CHIP }, String(board.items.length) + ' 个项目'),
      el('span', { className: CHIP }, String(filed) + ' 已归类'),
      el('span', { className: CHIP }, String(board.items.length - filed) + ' 待分类'),
      el('div', { className: 'flex-1' }),
      el('input', {
        className: cn(INPUT, 'w-40'),
        placeholder: '搜项目 / 路径 / 标注…',
        value: q,
        onChange: e => setQ(e.target.value)
      }),
      el(
        'button',
        {
          className: cn(BTN, classifying ? BTN_ON : null),
          type: 'button',
          title: '让 AI 把还没归类的项目分到六类里',
          disabled: classifying,
          style: classifying ? { opacity: 0.6 } : null,
          onClick: classifyNow
        },
        el(Codicon, { name: classifying ? 'sync~spin' : 'sparkle' }),
        classifying ? 'AI 归类中…' : 'AI 分类'
      ),
      el(
        'button',
        { className: BTN, type: 'button', title: '一行一个，批量录入项目', onClick: () => setDlg({ type: 'bulkAdd' }) },
        el(Codicon, { name: 'list-unordered' }),
        '批量添加'
      ),
      el(
        'button',
        { className: BTN, type: 'button', onClick: () => setDlg({ type: 'item' }) },
        el(Codicon, { name: 'add' }),
        '新建项目'
      ),
      el(
        'button',
        {
          className: cn(BTN, selMode ? BTN_ON : null),
          type: 'button',
          title: '勾选想删 / 想归类的项目',
          onClick: () => (selMode ? exitSel() : setSelMode(true))
        },
        el(Codicon, { name: 'checklist' }),
        selMode ? '退出选择' : '选择'
      ),
      el(
        'button',
        { className: BTN, type: 'button', title: '导出 / 导入 / 恢复 / 清空', onClick: () => setDlg({ type: 'io' }) },
        el(Codicon, { name: 'export' }),
        '导入导出'
      )
    ),
    selMode
      ? el(
          'div',
          {
            className:
              'flex flex-wrap items-center gap-2 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-2 py-1.5'
          },
          el('span', { className: 'text-xs text-(--ui-text-secondary)' }, '已选 ' + sel.length + ' 个'),
          el(
            'button',
            {
              className: BTN,
              type: 'button',
              onClick: () => setSel(allVisibleSelected ? [] : visible.map(it => it.id))
            },
            allVisibleSelected ? '全不选' : '全选'
          ),
          el('div', { className: 'flex-1' }),
          el(
            'button',
            {
              className: BTN,
              type: 'button',
              disabled: !sel.length,
              style: !sel.length ? { opacity: 0.5 } : null,
              onClick: () => setDlg({ type: 'assignMany' })
            },
            el(Codicon, { name: 'tag' }),
            '归到…'
          ),
          el(
            'button',
            {
              className: BTN,
              type: 'button',
              disabled: !sel.length,
              style: !sel.length ? { opacity: 0.5 } : null,
              onClick: () => setDlg({ type: 'deleteMany' })
            },
            el(Codicon, { name: 'trash' }),
            '删除选中'
          )
        )
      : null,
    el('div', { className: 'flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2' }, columns),
    dialog
  )
}

/* ============================ 入口 ============================ */

function Chip() {
  const board = useValue($board)
  const n = board ? board.items.length : 0
  const pending = board ? board.items.filter(it => !it.cat).length : 0

  return el(
    Tip,
    { label: pending ? '项目分类台 — 还有 ' + pending + ' 个没分类' : '项目分类台 · ' + n + ' 个项目' },
    el(
      'button',
      {
        className: cn(
          'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] tabular-nums transition-colors',
          'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
        ),
        type: 'button',
        onClick: () => host.navigate('/projects')
      },
      el(Codicon, { name: 'project', size: '0.7rem' }),
      el('span', null, String(n))
    )
  )
}

export default {
  id: ID,
  name: '项目分类台',
  defaultEnabled: true,
  register(ctx) {
    boot(ctx)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/projects' },
        render: function () {
          return jsx(Page, {})
        }
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/projects', label: '项目分类台', codicon: 'project' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'project-board.open',
          label: '打开项目分类台',
          keywords: ['项目', '分类', '标注', 'project', 'board', 'tag', 'fenlei', 'ai'],
          run: function () {
            host.navigate('/projects')
          }
        }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 126,
        render: function () {
          return jsx(Chip, {})
        }
      }
    ])

    // 首次装载 / 首次在这台机器上：等网关连上就自动跑一次 AI 全自动分类
    // （重试 3 次；失败用内置兜底，并打标记保证不会反复骚扰模型）
    if (autoClassifyMode && !autoClassifyDone) {
      try {
        if (ctx.storage && ctx.storage.set) ctx.storage.set(FLAG_KEY, { tried: Date.now() })
      } catch (e) {
        /* 标记写不进去就算了 */
      }

      log('auto-classify armed (mode=' + autoClassifyMode + '), firing in 4s')
      setTimeout(() => runAutoClassify(0), 4000)
    } else {
      log('auto-classify not armed | mode=' + String(autoClassifyMode) + ' done=' + String(autoClassifyDone))
    }
  }
}
