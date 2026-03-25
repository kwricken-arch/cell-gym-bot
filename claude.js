const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const VAULT_PATH = process.env.VAULT_PATH

function readFileIfExists(filePath) {
  try {
    if (!filePath) return ''
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    console.error('readFileIfExists error:', e)
    return ''
  }
}

function clipText(text, maxChars) {
  const t = String(text || '').trim()
  if (!t) return ''
  if (t.length <= maxChars) return t
  return t.slice(0, maxChars) + '\n...(省略)'
}

/* ===============================
   best_posts 読み込み
================================ */

function loadBestPosts(maxChars = 12000) {
  if (!VAULT_PATH) return ''

  const base = path.join(VAULT_PATH, '03_best_posts')
  let merged = ''

  const bestMd = path.join(base, 'best_posts.md')
  merged += '\n\n' + readFileIfExists(bestMd)

  const bestDir = path.join(base, 'best_posts')
  try {
    if (fs.existsSync(bestDir) && fs.statSync(bestDir).isDirectory()) {
      const files = fs.readdirSync(bestDir)
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .slice(0, 60)

      for (const f of files) {
        merged += '\n\n---\n\n' + readFileIfExists(path.join(bestDir, f))
      }
    }
  } catch (e) {
    console.error('loadBestPosts best_posts dir error:', e)
  }

  try {
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      const files = fs.readdirSync(base)
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .filter((f) => f !== 'best_posts.md')
        .slice(0, 40)

      for (const f of files) {
        merged += '\n\n---\n\n' + readFileIfExists(path.join(base, f))
      }
    }
  } catch (e) {
    console.error('loadBestPosts base dir error:', e)
  }

  return clipText(merged, maxChars)
}

/* ===============================
   best_posts 学習ブロック
================================ */

function buildBestPostsLearningBlock(bestPostsText) {
  if (!bestPostsText) return ''

  return [
    '【best_posts 学習データ】',
    '以下は過去に比較的評価が高かった投稿群です。',
    '文章のコピペは禁止。',
    '使ってよいのは「構造」「テンポ」「刺さる切り口」「フックの作り方」だけ。',
    '',
    'この学習データから特に反映すること：',
    '・1行目は短く刺す',
    '・症状名や悩み名を早めに出す',
    '・誤解の訂正、放置リスク、意外性のどれかを入れる',
    '・コメント欄1で原因→理由→改善の流れを作る',
    '・コメント欄2は押し売りせず自然に続きへ誘導する',
    '',
    bestPostsText,
  ].join('\n')
}

/* ===============================
   Threads 用プロンプト（フック強化版）
================================ */

function buildThreadsPrompt({ userText, vaultText, bestPostsText }) {
  const bestBlock = buildBestPostsLearningBlock(bestPostsText)

  const knowledgeBlock = vaultText
    ? [
        '【知識DB 抜粋】',
        '以下は今回のテーマに関連する知識DB。',
        '内容は参考にしてよいが、文章は必ず新しく書くこと。',
        '',
        vaultText,
      ].join('\n')
    : ''

  return [
    'あなたは細胞くん。日本語。',
    'キャラは、ちょいユーモア、でも納得感は医学っぽい。',
    '目的は Threads の保存率・フォロワー増・LINE導線の強化。',
    '',
    '【最重要ルール】',
    '・弱い書き出しは禁止',
    '・1行目は短く、強く、止まる言葉にする',
    '・2行目までに悩み名や症状名を出す',
    '・ただの一般論にしない',
    '・読者が「それ自分かも」と思う言い方にする',
    '・医療行為の断定は禁止。必要なら受診を促す',
    '',
    '【フック強化ルール】',
    '・最初の1行は「知らないと損」「そのままだと悪化」「実は原因が違う」のどれかに寄せる',
    '・曖昧で優しい始まりは禁止',
    '・「〜が大事です」「〜しましょう」から始めない',
    '・できるだけ症状名を先頭付近に置く',
    '・意外性、誤解破壊、放置リスクのいずれかを入れる',
    '・フックは短く、説明しすぎない',
    '',
    '【NG例】',
    '・便秘に悩んでいる人は多いです',
    '・健康のためには睡眠が大事です',
    '・疲れている人は生活習慣を見直しましょう',
    '',
    '【OKの方向性】',
    '・便秘、食物繊維不足だけ見てると悪化します',
    '・その眠気、昼食のせいじゃないです',
    '・疲労感、年齢のせいにすると長引きます',
    '・不眠、寝る前の習慣だけが原因じゃないです',
    '',
    '【出力フォーマット 固定】',
    '元の投稿（フック）：1〜3行',
    'コメント欄1：300〜500文字',
    'コメント欄2：自然なLINE誘導',
    '',
    '【元の投稿のルール】',
    '・短い',
    '・刺さる',
    '・症状名を入れる',
    '・誤解の訂正 or 放置リスク or 意外性のどれかを入れる',
    '',
    '【コメント欄1のルール】',
    '・最初に結論を軽く置く',
    '・なぜそうなるかを噛み砕いて説明する',
    '・人体機能学っぽい納得感を出す',
    '・最後に今日できる1アクションを入れる',
    '',
    '【コメント欄2のルール】',
    '・押し売り禁止',
    '・短め',
    '・続きが欲しい人向けの自然な導線にする',
    '',
    `今回の指示：${userText}`,
    '',
    bestBlock,
    '',
    knowledgeBlock,
  ]
    .filter(Boolean)
    .join('\n')
}

/* ===============================
   QA 用
================================ */

function buildQaPrompt({ userText, vaultText }) {
  return [
    'あなたは細胞くん。日本語。やさしく、断定しない。',
    '医療行為の断定は禁止。必要なら受診を促す。',
    '',
    `質問：${userText}`,
    '',
    vaultText ? ['【知識DB 抜粋】', vaultText].join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/* ===============================
   note 用
================================ */

function buildNotePrompt({ userText, vaultText, bestPostsText }) {
  const bestBlock = buildBestPostsLearningBlock(bestPostsText)

  return [
    'あなたは細胞くん。note の構成案を作る。日本語。',
    '',
    `テーマ：${userText}`,
    '',
    '【出力】',
    '・タイトル案 3つ',
    '・見出し構成',
    '・各章の要点',
    '・最後にCTA案',
    '',
    bestBlock,
    '',
    vaultText ? ['【知識DB 抜粋】', vaultText].join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/* ===============================
   Claude 呼び出し
================================ */

async function callClaude({ mode, userText, vaultText }) {
  const model = 'claude-sonnet-4-6'
  const bestPostsText = loadBestPosts(12000)

  let prompt = ''

  if (mode === 'threads') {
    prompt = buildThreadsPrompt({ userText, vaultText, bestPostsText })
  } else if (mode === 'qa') {
    prompt = buildQaPrompt({ userText, vaultText })
  } else if (mode === 'note') {
    prompt = buildNotePrompt({ userText, vaultText, bestPostsText })
  } else {
    throw new Error('Unknown mode: ' + mode)
  }

  const msg = await anthropic.messages.create({
    model,
    max_tokens: 1400,
    temperature: 0.8,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = (msg.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim()

  return text
}

module.exports = { callClaude, loadBestPosts }