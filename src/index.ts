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
        console.log('[getEthPrice] Using cached price:', ethPriceCache.price)
        return ethPriceCache.price
    }

    try {
        // Fetch from CoinGecko API (free, no auth required)
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')

        if (!response.ok) {
            throw new Error(`CoinGecko API returned status ${response.status}`)
        }

        const data = await response.json()

        // Validate response structure
        if (!data || !data.ethereum || typeof data.ethereum.usd !== 'number') {
            console.error('[getEthPrice] Invalid API response structure:', JSON.stringify(data))
            throw new Error('Invalid API response structure')
        }

        const price = data.ethereum.usd

        console.log('[getEthPrice] Fetched new price:', price)

        // Update cache
        ethPriceCache = { price, timestamp: now }

        return price
    } catch (error) {
        console.error('[getEthPrice] Error fetching price:', error)

        // Fallback: use cached price even if expired, or default to $3000
        if (ethPriceCache.price > 0) {
            console.log('[getEthPrice] Using expired cache:', ethPriceCache.price)
            return ethPriceCache.price
        }

        console.log('[getEthPrice] Using fallback price: 3000')
        return 3000 // Fallback price
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
        const balance = await publicClient.getBalance({ address: userWallet })
        const hasEnough = balance >= requiredEth

        console.log('[checkBalance]', {
            wallet: userWallet,
            balance: formatEther(balance),
            required: formatEther(requiredEth),
            hasEnough
        })

        return { hasEnough, balance }
    } catch (error) {
        console.error('[checkBalance] Error:', error)
        // If we can't check, assume they have enough (let transaction fail naturally)
        return { hasEnough: true, balance: 0n }
    }
}

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

// Helper function to parse amount from args
function parseAmountFromArgs(args: string[]): number | null {
    // Find the first arg that looks like a number
    for (const arg of args) {
        const cleaned = arg.replace(/,/g, '') // Remove commas
        const num = parseFloat(cleaned)
        if (!isNaN(num) && num > 0) {
            return num
        }
    }
    return null
}

bot.onSlashCommand('help', async (handler, { channelId }) => {
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
})

bot.onSlashCommand('time', async (handler, { channelId }) => {
    const currentTime = new Date().toLocaleString()
    await handler.sendMessage(channelId, `Current time: ${currentTime} ⏰`)
})

// Simple message responses
bot.onMessage(async (handler, event) => {
    const { message, channelId, eventId, createdAt, isMentioned } = event
    const lowerMsg = message.toLowerCase()

    // Respond when bot is mentioned
    if (isMentioned) {
        await handler.sendMessage(
            channelId,
            '👋 Hi! I help you send $ tips (auto-converted to ETH on Base).\n\nType `/help` to see all available commands!'
        )
        return
    }

    if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
        await handler.sendMessage(channelId, 'Hello there! 👋 Type `/help` to see what I can do!')
        return
    }

    if (lowerMsg.includes('ping')) {
        const latency = new Date().getTime() - createdAt.getTime()
        await handler.sendMessage(channelId, `Pong! 🏓 Latency: ${latency}ms`)
        return
    }

    if (lowerMsg.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        return
    }
})

bot.onReaction(async (handler, { reaction, channelId }) => {
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
    }
})

// /stats - town statistics
bot.onSlashCommand('stats', async (handler, event) => {
    const { channelId, spaceId } = event

    try {
        const stats = await getGlobalStats(spaceId)
        const ethPrice = await getEthPrice()

        const tipsVolume = parseFloat(stats.total_tips_volume) || 0
        const donationsVolume = parseFloat(stats.total_donations_volume) || 0
        const crowdfundingVolume = parseFloat(stats.total_crowdfunding_volume) || 0

        const tipsEth = tipsVolume / ethPrice
        const donationsEth = donationsVolume / ethPrice
        const crowdfundingEth = crowdfundingVolume / ethPrice
        const totalEth = (tipsVolume + donationsVolume + crowdfundingVolume) / ethPrice

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
    } catch (error) {
        console.error('[/stats] Error:', error)
        await handler.sendMessage(channelId, '❌ Failed to fetch statistics.')
    }
})

// /leaderboard - top tippers and donators in this town
bot.onSlashCommand('leaderboard', async (handler, event) => {
    const { channelId, spaceId } = event
    try {
        const topTippers = await getTopTippers(spaceId, 5)
        const topDonators = await getTopDonators(spaceId, 5)

        let message = `**🏆 Leaderboard 🏆**\n\n`

        // Top Tippers
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

        // Collect all mentioned users for proper mentions
        const mentions = [
            ...topTippers.map(e => ({ userId: e.user_id, displayName: e.display_name || 'User' })),
            ...topDonators.map(e => ({ userId: e.user_id, displayName: e.display_name || 'User' }))
        ]

        await handler.sendMessage(channelId, message, { mentions })
    } catch (error) {
        console.error('[/leaderboard] Error:', error)
        await handler.sendMessage(channelId, '❌ Failed to fetch leaderboard.')
    }
})
