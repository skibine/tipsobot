import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
import { parseUnits, hexToBytes, formatUnits, parseEther, formatEther } from 'viem'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import commands from './commands'
import {
    initDatabase,
    closeDatabase,
    getGlobalStats,
    updateGlobalStats,
    getUserStats,
    upsertUserStats,
    getTopTippers,
    getTopDonators,
    createPaymentRequest,
    getPaymentRequest,
    addContribution,
    getContributions,
    checkCooldown,
    updateCooldown,
    getRemainingCooldown,
    savePendingTransaction,
    getPendingTransaction,
    deletePendingTransaction,
    cleanupOldTransactions
} from './db'
import { handleFormResponse, handleTransactionResponse } from './handlers'
import { debugLog, debugError, trackRpcCall, trackRpcSuccess, trackRpcError, startHealthMonitor } from './debug-logger'

// ETH on Base - native currency
const ETH_DECIMALS = 18

// Public client for reading blockchain data
const publicClient = createPublicClient({
    chain: base,
    transport: http()
})

// Cache for ETH price (update every 5 minutes)
let ethPriceCache = { price: 0, timestamp: 0 }
const PRICE_CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

// Cooldown durations
const REQUEST_COOLDOWN = 24 * 60 * 60 * 1000 // 24 hours

// Helper function to format time remaining
function formatTimeRemaining(ms: number): string {
    const hours = Math.floor(ms / (60 * 60 * 1000))
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000))
    if (hours > 0) {
        return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
}

// Get current ETH price in USD
async function getEthPrice(): Promise<number> {
    const now = Date.now()

    // Return cached price if still valid
    if (ethPriceCache.price > 0 && (now - ethPriceCache.timestamp) < PRICE_CACHE_DURATION) {
        debugLog('getEthPrice', 'Using cached price', { price: ethPriceCache.price })
        return ethPriceCache.price
    }

    try {
        debugLog('getEthPrice', 'Fetching new price from CoinGecko...')
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')

        if (!response.ok) {
            throw new Error(`CoinGecko API returned status ${response.status}`)
        }

        const data = await response.json()

        if (!data || !data.ethereum || typeof data.ethereum.usd !== 'number') {
            debugError('getEthPrice', 'Invalid API response structure', data)
            throw new Error('Invalid API response structure')
        }

        const price = data.ethereum.usd
        debugLog('getEthPrice', 'Fetched new price successfully', { price })

        ethPriceCache = { price, timestamp: now }
        return price
    } catch (error) {
        debugError('getEthPrice', 'Error fetching price', error)

        if (ethPriceCache.price > 0) {
            debugLog('getEthPrice', 'Using expired cache', { price: ethPriceCache.price })
            return ethPriceCache.price
        }

        debugLog('getEthPrice', 'Using fallback price: 3000')
        return 3000
    }
}

// Convert USD to ETH amount
async function usdToEth(usdAmount: number): Promise<number> {
    const ethPrice = await getEthPrice()
    const ethAmount = usdAmount / ethPrice
    return ethAmount
}

// Check if user has enough ETH balance
async function checkBalance(userWallet: `0x${string}`, requiredEth: bigint): Promise<{ hasEnough: boolean, balance: bigint }> {
    try {
        trackRpcCall()
        const balance = await publicClient.getBalance({ address: userWallet })
        trackRpcSuccess()
        
        const hasEnough = balance >= requiredEth

        debugLog('checkBalance', 'Balance check complete', {
            wallet: userWallet.slice(0, 10) + '...',
            balance: formatEther(balance),
            required: formatEther(requiredEth),
            hasEnough
        })

        return { hasEnough, balance }
    } catch (error) {
        trackRpcError(error)
        debugError('checkBalance', 'Error checking balance', error)
        return { hasEnough: true, balance: 0n }
    }
}

debugLog('INIT', 'Creating Towns bot instance...')
const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})
debugLog('INIT', 'Bot instance created successfully')

// Helper function to parse amount from args
function parseAmountFromArgs(args: string[]): number | null {
    for (const arg of args) {
        const cleaned = arg.replace(/,/g, '')
        const num = parseFloat(cleaned)
        if (!isNaN(num) && num > 0) {
            return num
        }
    }
    return null
}

bot.onSlashCommand('help', async (handler, { channelId }) => {
    debugLog('/help', 'START')
    trackRpcCall()
    
    const ethPrice = await getEthPrice()

    await handler.sendMessage(
        channelId,
        `**TipsoBot - Send $ tips on Base** 💸\n\n` +
            `**Tipping:**\n` +
            `• \`/tip @user amount\` - Send money to a user\n` +
            `• \`/tipsplit @user1 @user2 amount\` - Split equally\n` +
            `• \`/donate amount\` - Support the bot\n\n` +
            `**Crowdfunding:**\n` +
            `• \`/request amount description\` - Create payment request\n` +
            `• \`/contribute requestId amount\` - Contribute to request\n\n` +
            `**Stats:**\n` +
            `• \`/stats\` - Your tipping statistics\n` +
            `• \`/leaderboard\` - Top tippers & donators\n\n` +
            `**Other:**\n` +
            `• \`/help\` - Show this message\n` +
            `• \`/time\` - Current server time\n\n` +
            `**Info:**\n` +
            `• All amounts in USD ($), auto-converted to ETH\n` +
            `• Current ETH price: $${ethPrice.toFixed(2)}\n`
    )
    
    trackRpcSuccess()
    debugLog('/help', 'END')
})

bot.onSlashCommand('time', async (handler, { channelId }) => {
    debugLog('/time', 'START')
    trackRpcCall()
    
    const currentTime = new Date().toLocaleString()
    await handler.sendMessage(channelId, `Current time: ${currentTime} ⏰`)
    
    trackRpcSuccess()
    debugLog('/time', 'END')
})

// /stats - town statistics
bot.onSlashCommand('stats', async (handler, event) => {
    const { channelId, spaceId } = event

    debugLog('/stats', 'START', { spaceId })
    trackRpcCall()

    try {
        debugLog('/stats', 'Calling getGlobalStats...')
        const stats = await getGlobalStats(spaceId)
        debugLog('/stats', 'Got stats from DB', { stats })
        
        const ethPrice = await getEthPrice()

        const tipsVolume = parseFloat(stats.total_tips_volume) || 0
        const donationsVolume = parseFloat(stats.total_donations_volume) || 0
        const crowdfundingVolume = parseFloat(stats.total_crowdfunding_volume) || 0

        const tipsEth = tipsVolume / ethPrice
        const donationsEth = donationsVolume / ethPrice
        const crowdfundingEth = crowdfundingVolume / ethPrice
        const totalEth = (tipsVolume + donationsVolume + crowdfundingVolume) / ethPrice

        debugLog('/stats', 'Sending response...')
        await handler.sendMessage(
            channelId,
            `**📊 TipsoBot Statistics**\n\n` +
                `**💸 Tips:**\n` +
                `• Volume: $${tipsVolume.toFixed(2)} (~${tipsEth.toFixed(6)} ETH)\n` +
                `• Count: ${stats.total_tips_count} transactions\n\n` +
                `**❤️ Donations to Bot:**\n` +
                `• Volume: $${donationsVolume.toFixed(2)} (~${donationsEth.toFixed(6)} ETH)\n` +
                `• Count: ${stats.total_donations_count} donations\n\n` +
                `**💰 Crowdfunding:**\n` +
                `• Volume: $${crowdfundingVolume.toFixed(2)} (~${crowdfundingEth.toFixed(6)} ETH)\n` +
                `• Requests: ${stats.total_crowdfunding_count} funded\n\n` +
                `**🌐 Total Volume:** $${(tipsVolume + donationsVolume + crowdfundingVolume).toFixed(2)} (~${totalEth.toFixed(6)} ETH)\n\n` +
                `Use \`/leaderboard\` to see top contributors! 🏆`
        )
        
        trackRpcSuccess()
        debugLog('/stats', 'END - Success')
    } catch (error) {
        debugError('/stats', 'Error', error)
        trackRpcError(error)
        await handler.sendMessage(channelId, '❌ Failed to fetch statistics.')
    }
})

// /leaderboard - top tippers and donators in this town
bot.onSlashCommand('leaderboard', async (handler, event) => {
    const { channelId, spaceId } = event
    
    debugLog('/leaderboard', 'START', { spaceId })
    trackRpcCall()
    
    try {
        debugLog('/leaderboard', 'Fetching top tippers...')
        const topTippers = await getTopTippers(spaceId, 5)
        debugLog('/leaderboard', 'Got tippers', { count: topTippers.length })
        
        debugLog('/leaderboard', 'Fetching top donators...')
        const topDonators = await getTopDonators(spaceId, 5)
        debugLog('/leaderboard', 'Got donators', { count: topDonators.length })

        let message = `**🏆 Leaderboard 🏆**\n\n`

        message += `**Top Tippers:**\n`
        if (topTippers.length === 0) {
            message += `_No tippers yet_\n`
        } else {
            topTippers.forEach((entry, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`
                const amount = parseFloat(entry.amount) || 0
                message += `${medal} <@${entry.user_id}>: $${amount.toFixed(2)} (${entry.count} tips)\n`
            })
        }

        message += `\n**Top Donators:**\n`
        if (topDonators.length === 0) {
            message += `_No donators yet_\n`
        } else {
            topDonators.forEach((entry, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`
                const amount = parseFloat(entry.amount) || 0
                message += `${medal} <@${entry.user_id}>: $${amount.toFixed(2)} (${entry.count} donations)\n`
            })
        }

        const mentions = [
            ...topTippers.map(e => ({ userId: e.user_id, displayName: e.display_name || 'User' })),
            ...topDonators.map(e => ({ userId: e.user_id, displayName: e.display_name || 'User' }))
        ]

        debugLog('/leaderboard', 'Sending response...')
        await handler.sendMessage(channelId, message, { mentions })
        
        trackRpcSuccess()
        debugLog('/leaderboard', 'END - Success')
    } catch (error) {
        debugError('/leaderboard', 'Error', error)
        trackRpcError(error)
        await handler.sendMessage(channelId, '❌ Failed to fetch leaderboard.')
    }
})

// Initialize database and start bot
debugLog('INIT', 'Initializing database...')
await initDatabase()
debugLog('INIT', 'Database initialized successfully')

debugLog('INIT', 'Starting bot...')
const app = bot.start()

startHealthMonitor()
debugLog('INIT', 'Health monitor started')

app.get('/', (c) => c.text('TipsoBot is running! 💸'))

app.post('/webhook', async (c) => {
    const body = await c.req.json()
    
    debugLog('WEBHOOK', 'Received webhook', {
        hasEvent: !!body?.event,
        eventType: body?.event?.type,
        userId: body?.event?.userId?.slice(0, 10),
        channelId: body?.event?.channelId?.slice(0, 10)
    })

    return c.json({ ok: true }, 200)
})

setInterval(async () => {
    try {
        debugLog('CLEANUP', 'Running cleanup...')
        await cleanupOldTransactions()
        debugLog('CLEANUP', 'Cleanup completed')
    } catch (error) {
        debugError('CLEANUP', 'Error during cleanup', error)
    }
}, 60 * 60 * 1000)

const shutdown = async (signal: string) => {
    debugLog('SHUTDOWN', `Received ${signal}, shutting down...`)
    try {
        await closeDatabase()
        debugLog('SHUTDOWN', 'Database closed successfully')
        process.exit(0)
    } catch (error) {
        debugError('SHUTDOWN', 'Error during shutdown', error)
        process.exit(1)
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', (error: any) => {
    debugError('GLOBAL', 'Unhandled rejection', error)
    trackRpcError(error)
})

process.on('uncaughtException', (error: any) => {
    debugError('GLOBAL', 'Uncaught exception', error)
    trackRpcError(error)
})

debugLog('INIT', 'Bot started successfully! 🚀')

export default app