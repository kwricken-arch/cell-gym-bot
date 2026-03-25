const fs = require('fs')
const path = require('path')

const VAULT_PATH = process.env.VAULT_PATH
const GYM_PATH = '04_細胞ジム'

function readFile(name) {
  const full = path.join(VAULT_PATH, GYM_PATH, name)
  if (!fs.existsSync(full)) return []
  const text = fs.readFileSync(full, 'utf8')

  return text
    .split('---')
    .map(s => s.trim())
    .filter(Boolean)
}

function getRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function getMenu(time) {
  const fixed = readFile(`${time}_固定.md`)
  const randoms = readFile(`${time}_ランダム.md`)

  const randomOne = getRandom(randoms)

  return {
    fixed,
    random: randomOne
  }
}

module.exports = { getMenu }