require('dotenv').config()

const { callClaude } = require('./claude')
const { Client, GatewayIntentBits, Events } = require('discord.js')

const fs = require('fs')
const path = require('path')

const { scorePost } = require('./scorer')
const { saveBestPost } = require('./bestSaver')
const { saveThreadsLog } = require('./logger')
const { startScheduler } = require('./scheduler')

let loadBestPosts = null
let parseAnalyzeCommand = null
let parseTodayCommand = null

try {
  const analyzer = require('./analyzer')
  loadBestPosts = analyzer.loadBestPosts
  parseAnalyzeCommand = analyzer.parseAnalyzeCommand
  parseTodayCommand = analyzer.parseTodayCommand
} catch (e) {
  console.log('analyzer.js 読み込みスキップ')
}

/* ===============================
   Discord Client
================================ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.once(Events.ClientReady, () => {
  console.log(`ログイン成功：${client.user.tag}`)
startScheduler(client)
})

/* ===============================
   チャンネルごとの動作設定
================================ */

const CHANNEL_MODE = {
  'threads投稿部屋': 'threads',
  '質問部屋-安全': 'qa',
  '質問部屋-バランス': 'qa',
  'note執筆部屋': 'note',
}

/* ===============================
   Vault設定
================================ */

const VAULT_PATH = process.env.VAULT_PATH
const DB_FILE = '01_知識DB/悩みDB.md'
const LINE_DB_FILE = '01_知識DB/LINE配信DB.md'

function readDbFile() {
  try {
    const fullPath = path.join(VAULT_PATH, DB_FILE)
    if (!fs.existsSync(fullPath)) return ''
    return fs.readFileSync(fullPath, 'utf8')
  } catch (e) {
    console.error('readDbFile error:', e)
    return ''
  }
}

/* ===============================
   LINE配信DB 読み込み
================================ */

function readLineDb() {
  try {
    const fullPath = path.join(VAULT_PATH, LINE_DB_FILE)
    if (!fs.existsSync(fullPath)) return ''
    return fs.readFileSync(fullPath, 'utf8')
  } catch (e) {
    console.error('readLineDb error:', e)
    return ''
  }
}

function pickLineExamples(n = 5) {
  const content = readLineDb()
  if (!content) return ''

  const blocks = content
    .split('---')
    .map((s) => s.trim())
    .filter(Boolean)

  const shuffled = blocks.sort(() => 0.5 - Math.random())
  return shuffled.slice(0, n).join('\n\n---\n\n')
}

/* ===============================
   DB検索
================================ */

function normalizeText(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function parseDbSections() {
  const content = readDbFile()
  const lines = content.split(/\r?\n/)

  const sections = []
  let current = null

  for (const line of lines) {
    const m = line.match(/^##\s+(.*)\s*$/)
    if (m) {
      if (current) sections.push(current)
      current = { heading: m[1].trim(), bodyLines: [] }
      continue
    }
    if (current) current.bodyLines.push(line)
  }

  if (current) sections.push(current)

  return sections.map((s) => ({
    heading: s.heading,
    body: s.bodyLines.join('\n').trim(),
  }))
}

function searchDbSectionByKeyword(keyword) {
  const keyRaw = (keyword || '').trim()
  if (!keyRaw) return null

  const key = normalizeText(keyRaw)
  if (!key) return null

  const sections = parseDbSections()

  const exact = sections.find((s) => normalizeText(s.heading) === key)
  if (exact) return exact.body

  const partial = sections.find((s) => normalizeText(s.heading).includes(key))
  if (partial) return partial.body

  const bodyHit = sections.find((s) => normalizeText(s.body).includes(key))
  if (bodyHit) return bodyHit.body

  return null
}

/* ===============================
   入力解析（朝昼夕夜 / ランダム / テーマ）
================================ */

function parseUserInput(text) {
  const raw = (text || '').trim()
  const tokens = raw.split(/\s+/)

  const isMode = (t) => ['朝', '昼', '夕', '夜'].includes(t)
  const isRandom = (t) => t === 'ランダム'

  let mode = null
  let random = false
  const rest = []

  for (const t of tokens) {
    if (!mode && isMode(t)) {
      mode = t
      continue
    }
    if (isRandom(t)) {
      random = true
      continue
    }
    rest.push(t)
  }

  const keyword = rest.join(' ').trim()

  if (!mode && !random && !keyword) random = true

  let userTextForClaude = keyword || 'ランダム'
  if (random && !keyword) userTextForClaude = 'ランダム'
  if (mode) userTextForClaude = `${mode} ${userTextForClaude}`

  return {
    mode,
    random,
    keyword,
    userTextForClaude,
  }
}

/* ===============================
   コマンド解析
================================ */

function parseAutoCommand(text) {
  const raw = (text || '').trim()

  const m1 = raw.match(/^ネタ\s*(\d+)?$/)
  if (m1) {
    const n = m1[1] ? parseInt(m1[1], 10) : 10
    return { type: 'ideas', n: Math.min(Math.max(n, 1), 50) }
  }

  const m2 = raw.match(/^自動\s*(\d+)?$/)
  if (m2) {
    const n = m2[1] ? parseInt(m2[1], 10) : 10
    return { type: 'auto', n: Math.min(Math.max(n, 1), 30) }
  }

  return null
}

function parseReserveCommand(text) {
  const raw = (text || '').trim()
  const m = raw.match(/^予約\s*(\d+)?$/)
  if (!m) return null
  const n = m[1] ? parseInt(m[1], 10) : 5
  return { n: Math.min(Math.max(n, 1), 5) }
}

/* ===============================
   予約パック保存（時刻つき）
================================ */

function ymdTokyo() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function timeTokyo() {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  return `${h}${m}`
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function saveDailyPack({ vaultPath, fileName, content }) {
  const dir = path.join(vaultPath, '00_実戦ログ', '予約パック')
  ensureDir(dir)
  const outPath = path.join(dir, fileName)
  fs.writeFileSync(outPath, content, 'utf8')
  return outPath
}

/* ===============================
   best_posts からテーマ抽出
================================ */

function extractThemesFromBestPosts(bestText, maxCount = 60) {
  const text = String(bestText || '')
  if (!text) return []

  const lines = text.split(/\r?\n/)
  const themes = []

  for (const line of lines) {
    const s = line.trim()
    if (!s) continue

    if (s.includes('_score')) continue
    if (s.startsWith('date:')) continue
    if (s.startsWith('type:')) continue
    if (s.startsWith('---')) continue

    const cleaned = s
      .replace(/^\d+[\.\)]\s*/, '')
      .replace(/^[-・#]+\s*/, '')
      .trim()

    if (!cleaned) continue
    if (cleaned.length < 2) continue
    if (cleaned.length > 40) continue

    if (!themes.includes(cleaned)) {
      themes.push(cleaned)
    }

    if (themes.length >= maxCount) break
  }

  return themes
}

/* ===============================
   ネタ生成（悩みDB見出し → 空ならbest_posts）
================================ */

async function generateIdeasWithClaude({ count, headings }) {
  const safeHeadings = Array.isArray(headings) ? headings.filter(Boolean) : []
  let sourceList = safeHeadings

  if (sourceList.length === 0 && loadBestPosts) {
    const bestText = loadBestPosts(VAULT_PATH, 12000)
    sourceList = extractThemesFromBestPosts(bestText, 60)
  }

  if (sourceList.length === 0) {
    sourceList = ['便秘', '疲労感', '不眠', 'だるさ', '頭痛', '胃もたれ']
  }

  const list = sourceList.slice(0, 120).join('\n')

  const prompt = [
    'あなたはThreads投稿の編集長。日本語。',
    '目的はフォロワー増と保存率。',
    '',
    '以下は投稿テーマ候補。',
    'ここから伸びやすいテーマを選び、読者が反応しやすい言い方に作り直して。',
    `個数は${count}個。`,
    '',
    '出力は番号つきの箇条書きのみ。',
    '余計な説明は書かない。',
    '',
    '候補:',
    list,
  ].join('\n')

  const out = await callClaude({
    mode: 'qa',
    userText: prompt,
    vaultText: null,
  })

  const lines = (out || '')
    .split('\n')
    .map((s) =>
      s
        .replace(/^\s*\d+[\.\)]\s*/, '')
        .replace(/^\s*[-・]\s*/, '')
        .trim()
    )
    .filter(Boolean)

  return lines.slice(0, count)
}

/* ===============================
   LINE誘導一文（候補）
================================ */

function pickLineTease() {
  const arr = [
    'これ、効果がぐっと上がるコツがあるんだけど、長くなるから今夜LINEでだけ話すね🍀',
    '実はこのあと、効き目を上げるスイッチがある。今夜LINEでこっそり出すね✨',
    'ここまでやると変わるんだけど、最後の1ピースだけ今夜LINEに置いとくね🍚',
    '続き、知りたい人いる？今夜LINEで答えだけまとめて送るね。',
  ]
  return arr[Math.floor(Math.random() * arr.length)]
}

/* ===============================
   Discord受信
================================ */

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return

  const channelName = message.channel?.name || ''
  const channelMode = CHANNEL_MODE[channelName] || 'ignore'
  if (channelMode === 'ignore') return

  const text = (message.content || '').trim()
  if (!text) return

  try {
    /* ===== Threads投稿部屋 ===== */
    if (channelMode === 'threads') {
      /* ===== 分析 ===== */
      const analyzeCmd = parseAnalyzeCommand ? parseAnalyzeCommand(text) : null
      if (analyzeCmd) {
        await message.reply('了解。best_postsを分析します。')

        const bestText = loadBestPosts ? loadBestPosts(VAULT_PATH, 12000) : ''

        const prompt = [
          'あなたはThreads投稿の編集長。目的はフォロワー増と保存率。',
          '以下は良い投稿データ。共通点を抽象化して分析して。',
          '',
          '出力順',
          '1 伸びる投稿の共通構造',
          '2 強いフックのパターン',
          '3 コメント欄1の型',
          '4 コメント欄2の型',
          '5 NGパターン',
          '',
          '注意',
          '引用やコピペは禁止。抽象化して。',
          '',
          '投稿データ',
          bestText || 'データが空です。03_best_postsに投稿を入れてください。',
        ].join('\n')

        const analysis = await callClaude({
          mode: 'qa',
          userText: prompt,
          vaultText: null,
        })

        await message.reply(analysis)
        return
      }

      /* ===== 今日の候補 ===== */
      const todayCmd = parseTodayCommand ? parseTodayCommand(text) : null
      if (todayCmd) {
        await message.reply('了解。今日出す候補を選びます。')

        const bestText = loadBestPosts ? loadBestPosts(VAULT_PATH, 12000) : ''

        const prompt = [
          'あなたはThreads投稿の編集長。日本語。',
          '以下は良い投稿データ。ここから今日出すべき投稿案を選んで。',
          '',
          `個数は${todayCmd.n}個。`,
          '出力形式：番号つきで、各項目は',
          '・テーマ（短く）',
          '・狙う読者（誰向け）',
          '・フック案（1〜2行）',
          '・この投稿が伸びる理由（1行）',
          '',
          '投稿データ:',
          bestText || 'データが空です。03_best_postsに投稿を入れてください。',
        ].join('\n')

        const out = await callClaude({
          mode: 'qa',
          userText: prompt,
          vaultText: null,
        })

        await message.reply(out)
        return
      }

      /* ===== 予約パック（予約 5） ===== */
      const reserveCmd = parseReserveCommand(text)
      if (reserveCmd) {
        const want = reserveCmd.n

        await message.reply('了解。予約パックを作ります（Threads4本＋LINE1本）。できたらObsidianに保存します。')

        const headings = parseDbSections()
          .map((s) => s.heading)
          .filter(Boolean)

        const topics = await generateIdeasWithClaude({ count: 4, headings })

        const slots = ['朝', '昼', '夕', '夜']
        const posts = []

        const teaseIndex = Math.floor(Math.random() * 4)
        const teaseLine = pickLineTease()

        let teasedPostText = ''
        let teasedTopic = ''
        let teasedSlot = ''
        let teasedMemo = ''

        for (let i = 0; i < 4; i++) {
          const slot = slots[i]
          const topic = topics[i] || headings[i] || 'ランダム'
          const vaultText = searchDbSectionByKeyword(topic)

          const addTease =
            i === teaseIndex
              ? `\n\n【追加指示】コメント欄2の最後に、次の1文を自然に追加して：\n${teaseLine}\n`
              : ''

          const post = await callClaude({
            mode: 'threads',
            userText: `${slot} ${topic}${addTease}`,
            vaultText,
          })

          try {
            saveThreadsLog({
              vaultPath: VAULT_PATH,
              channelName,
              topic: `${slot} ${topic}`,
              output: post,
            })
          } catch (e) {
            console.error('投稿ログ保存でエラー:', e)
          }

          try {
            const scoreResult = await scorePost(topic, post)
            if (scoreResult && typeof scoreResult.score === 'number' && scoreResult.score >= 7) {
              saveBestPost(VAULT_PATH, topic, post, scoreResult.score)
            }
          } catch (e) {
            console.error('採点 or best保存でエラー:', e)
          }

          posts.push({ slot, topic, post })

          if (i === teaseIndex) {
            teasedPostText = post
            teasedTopic = topic
            teasedSlot = slot

            try {
              const memoPrompt = [
                'あなたは細胞くん。日本語。',
                '次のThreads投稿の匂わせ部分の答えとして、LINEで渡すための答えメモを作る。',
                '出力は短く1〜2行で、答えだけ。',
                '',
                '投稿:',
                post,
              ].join('\n')

              const memo = await callClaude({
                mode: 'qa',
                userText: memoPrompt,
                vaultText: null,
              })

              teasedMemo = (memo || '').trim()
            } catch (e) {
              console.error('LINE答えメモ生成でエラー:', e)
              teasedMemo = '（答えメモ生成に失敗）'
            }
          }
        }

        let lineText = ''
        if (want >= 5) {
          const lineExamples = pickLineExamples(5)

          const linePrompt = [
            'あなたは細胞くん。LINEオプチャ配信用の文章を作る。日本語。',
            '',
            '目的：Threads投稿からLINE登録してくれた人に「続き」を届ける。',
            'LINEはThreadsの延長であり、答え回収＋深掘りをする。',
            '',
            '重要ルール：',
            '・Threadsの続きとして書く',
            '・答えを最初に回収する',
            '・人体機能学の説明を入れる',
            '・がん細胞の視点を少し入れる',
            '・最後はスタンプ誘導',
            '',
            '参考LINE文（文体を参考にする）：',
            lineExamples || '（参考データが空）',
            '',
            '対象のThreads投稿：',
            teasedPostText || '（投稿が空）',
            '',
            '匂わせの答え：',
            teasedMemo || '（答えが空）',
            '',
            '出力構造：',
            '① Threads見た？',
            '② 今日の答え',
            '③ なぜ効くか',
            '④ もう少し深掘り',
            '⑤ 今日の実践',
            '⑥ スタンプ誘導',
          ].join('\n')

          lineText = await callClaude({
            mode: 'qa',
            userText: linePrompt,
            vaultText: null,
          })
        }

        const date = ymdTokyo()
        const fileName = `${date}_予約パック_${timeTokyo()}.md`

        const packMd = [
          '---',
          `date: ${date}`,
          'type: daily_pack',
          `line_tease_inserted_in: ${posts[teaseIndex]?.slot || 'unknown'}`,
          '---',
          '',
          '# Threads 予約パック',
          '',
          `LINE誘導を入れた投稿：${posts[teaseIndex]?.slot || ''}（ランダム）`,
          '',
          ...posts.map((p, i) =>
            [
              '---',
              `## ${i + 1} ${p.slot}｜${p.topic}`,
              '',
              p.post,
              '',
            ].join('\n')
          ),
          want >= 5
            ? [
                '---',
                '# LINE配信（夕方〜夜に送る想定）',
                `対象：${teasedSlot}｜${teasedTopic}`,
                '',
                String(lineText || '').trim(),
                '',
              ].join('\n')
            : '',
        ]
          .filter(Boolean)
          .join('\n')

        const savedPath = saveDailyPack({
          vaultPath: VAULT_PATH,
          fileName,
          content: packMd,
        })

        await message.reply(`保存しました：${savedPath}\n（Obsidianで 00_実戦ログ/予約パック にあります）`)
        await message.reply(`LINE誘導を入れたのは「${posts[teaseIndex]?.slot}」の投稿です。`)
        await message.reply(`1本目（朝｜${posts[0].topic}）\n\n${posts[0].post}`)

        return
      }

      /* ===== ネタ / 自動 ===== */
      const cmd = parseAutoCommand(text)

      if (cmd && cmd.type === 'ideas') {
        const headings = parseDbSections()
          .map((s) => s.heading)
          .filter(Boolean)

        const ideas = await generateIdeasWithClaude({ count: cmd.n, headings })
        const msg = ideas.map((t, i) => `${i + 1}. ${t}`).join('\n')
        await message.reply(msg || 'ネタが作れませんでした。')
        return
      }

      if (cmd && cmd.type === 'auto') {
        await message.reply(`了解。自動で${cmd.n}本作って保存します。7点以上はbest_postsに保存します。`)

        const headings = parseDbSections()
          .map((s) => s.heading)
          .filter(Boolean)

        const topics = await generateIdeasWithClaude({ count: cmd.n, headings })

        let firstPost = null
        let firstTopic = null

        let bestCount = 0
        let savedCount = 0

        for (let i = 0; i < topics.length; i++) {
          const topic = topics[i] || 'ランダム'
          const vaultText = searchDbSectionByKeyword(topic)

          const post = await callClaude({
            mode: 'threads',
            userText: topic,
            vaultText,
          })

          try {
            saveThreadsLog({
              vaultPath: VAULT_PATH,
              channelName,
              topic,
              output: post,
            })
            savedCount++
          } catch (e) {
            console.error('投稿ログ保存でエラー:', e)
          }

          try {
            const scoreResult = await scorePost(topic, post)
            if (scoreResult && typeof scoreResult.score === 'number' && scoreResult.score >= 7) {
              saveBestPost(VAULT_PATH, topic, post, scoreResult.score)
              bestCount++
            }
          } catch (e) {
            console.error('採点 or best保存でエラー:', e)
          }

          if ((i + 1) % 5 === 0) {
            try {
              await message.reply(`進捗 ${i + 1}/${topics.length} 保存 ${savedCount} best ${bestCount}`)
            } catch (e) {
              console.error('進捗返信でエラー:', e)
            }
          }

          if (!firstPost) {
            firstPost = post
            firstTopic = topic
          }
        }

        if (firstPost) {
          await message.reply(`自動生成の1本目（テーマ：${firstTopic}）\n\n${firstPost}`)
        } else {
          await message.reply('自動生成できませんでした。')
        }

        await message.reply(`完了。保存 ${savedCount}/${topics.length} best ${bestCount}`)
        return
      }

      /* ===== 通常の1本生成 ===== */
      const input = parseUserInput(text)

      let vaultText = null
      if (input.keyword) {
        vaultText = searchDbSectionByKeyword(input.keyword)
      }

      const result = await callClaude({
        mode: 'threads',
        userText: input.userTextForClaude,
        vaultText,
      })

      await message.reply(result)

      try {
        saveThreadsLog({
          vaultPath: VAULT_PATH,
          channelName,
          topic: input.keyword || input.userTextForClaude || 'ランダム',
          output: result,
        })
      } catch (e) {
        console.error('投稿ログ保存でエラー:', e)
      }

      ;(async () => {
        try {
          const topicForScore = input.keyword || 'ランダム'
          const scoreResult = await scorePost(topicForScore, result)
          if (scoreResult && typeof scoreResult.score === 'number' && scoreResult.score >= 7) {
            saveBestPost(VAULT_PATH, topicForScore, result, scoreResult.score)
          }
        } catch (e) {
          console.error('採点 or best保存でエラー（投稿は正常）:', e)
        }
      })()

      return
    }

    /* ===== 質問部屋 ===== */
    if (channelMode === 'qa') {
      const vaultText = searchDbSectionByKeyword(text)

      const result = await callClaude({
        mode: 'qa',
        userText: text,
        vaultText,
      })

      await message.reply(result)
      return
    }

    /* ===== note執筆部屋 ===== */
    if (channelMode === 'note') {
      const vaultText = searchDbSectionByKeyword(text)

      const result = await callClaude({
        mode: 'note',
        userText: text,
        vaultText,
      })

      await message.reply(result)
      return
    }
  } catch (err) {
    console.error(err)
    try {
      await message.reply('エラーが発生しました。')
    } catch {}
  }
})

client.login(process.env.DISCORD_TOKEN)