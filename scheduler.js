const { getMenu } = require('./gymReader')

function startScheduler(client) {
  setInterval(async () => {
    const now = new Date()
    const hour = now.getHours()
    const min = now.getMinutes()

    if (min !== 0) return

    let time = null

    if (hour === 7) time = '朝'
    if (hour === 12) time = '昼'
    if (hour === 17) time = '夕'
    if (hour === 21) time = '夜'

    if (!time) return

    const channel = client.channels.cache.find(c => c.name === '細胞ジム配信')
    if (!channel) return

    const menu = getMenu(time)

    const text = `
【${time}の細胞トレーニング】

① ${menu.fixed[0] || ''}
② ${menu.fixed[1] || ''}
③ ${menu.fixed[2] || ''}

＋ 今日の追加
👉 ${menu.random || ''}
`

    await channel.send(text)

  }, 60000)
}

module.exports = { startScheduler }