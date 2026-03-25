const fs = require('fs')
const path = require('path')

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function safeFileName(name) {
  return String(name || '')
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
}

function nowStamp() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`
}

/**
 * score >= 7 で best_posts
 * score >= 9 で best_posts_elite にも保存
 */
function saveBestPost(vaultPath, topic, postText, score) {
  if (!vaultPath) throw new Error('vaultPath is required')

  const baseDir = path.join(vaultPath, '03_best_posts')
  ensureDir(baseDir)

  // 通常best
  const bestDir = path.join(baseDir, 'best_posts')
  ensureDir(bestDir)

  const stamp = nowStamp()
  const file = `${stamp}_${safeFileName(topic)}_score${score}.md`
  const outPath = path.join(bestDir, file)

  const body = [
    '---',
    `topic: ${topic}`,
    `score: ${score}`,
    `saved_at: ${stamp}`,
    '---',
    '',
    postText,
    '',
  ].join('\n')

  fs.writeFileSync(outPath, body, 'utf8')

  // elite（9以上だけ）
  if (typeof score === 'number' && score >= 9) {
    const eliteDir = path.join(baseDir, 'best_posts_elite')
    ensureDir(eliteDir)

    const elitePath = path.join(eliteDir, file)
    fs.writeFileSync(elitePath, body, 'utf8')
  }

  return outPath
}

module.exports = { saveBestPost }