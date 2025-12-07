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

// Store pending tip confirmations
const pendingTips = new Map<string, {
    recipients: Array<{ userId: string, displayName: string, wallet: `0x${string}`, amount: number }>,
    totalAmount: number
}>()

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

// /tip @username amount
bot.onSlashCommand('tip', async (handler, event) => {
    const { args, mentions, channelId, userId, eventId } = event

    console.log('[/tip] Received:', { args, mentions: mentions.length, userId })

    // Validate mentions
    if (mentions.length === 0) {
        console.log('[/tip] No mentions found')
        await handler.sendMessage(channelId, '❌ Please mention a user to tip.\n**Usage:** `/tip @username amount`')
        return
    }

    if (mentions.length > 1) {
        console.log('[/tip] Too many mentions:', mentions.length)
        await handler.sendMessage(channelId, '❌ Please mention only ONE user. Use `/tipsplit` for multiple users.')
        return
    }

    const recipient = mentions[0]

    // Check if user is trying to tip themselves
    if (recipient.userId === userId) {
        console.log('[/tip] Self-tip attempt')
        await handler.sendMessage(channelId, '❌ You cannot tip yourself! 😅')
        return
    }

    // Parse amount in USD
    const usdAmount = parseAmountFromArgs(args)
    console.log('[/tip] Parsed amount:', usdAmount, 'USD from args:', args)

    if (usdAmount === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/tip @username amount`')
        return
    }

    if (usdAmount <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        return
    }

    try {
        // Get recipient's wallet
        console.log('[/tip] Getting wallet for:', recipient.userId)
        const recipientWallet = await getSmartAccountFromUserId(bot, { userId: recipient.userId })
        console.log('[/tip] Wallet found:', recipientWallet)

        if (!recipientWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find wallet for the mentioned user.')
            return
        }

        // Get sender's wallet to check balance
        const senderWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!senderWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            return
        }

        // Convert USD to ETH
        const ethAmount = await usdToEth(usdAmount)
        const ethAmountWei = parseEther(ethAmount.toString())

        console.log('[/tip] Converted:', usdAmount, 'USD →', ethAmount, 'ETH')

        // Check if sender has enough balance
        const { hasEnough, balance } = await checkBalance(senderWallet as `0x${string}`, ethAmountWei)

        if (!hasEnough) {
            const balanceUsd = (parseFloat(formatEther(balance)) * await getEthPrice()).toFixed(2)
            await handler.sendMessage(
                channelId,
                `❌ Insufficient balance!\n\n` +
                `**Required:** $${usdAmount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH)\n` +
                `**Your balance:** $${balanceUsd} (~${formatEther(balance)} ETH)\n\n` +
                `Please add more funds to your wallet.`
            )
            return
        }

        // Store pending tip
        const requestId = `tip-${eventId}`
        pendingTips.set(requestId, {
            recipients: [{
                userId: recipient.userId,
                displayName: recipient.displayName,
                wallet: recipientWallet as `0x${string}`,
                amount: ethAmount // Store ETH amount for transaction
            }],
            totalAmount: ethAmount
        })

        console.log('[/tip] Sending confirmation dialog')

        // Send confirmation dialog
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `💸 Confirm Tip`,
                description: `Send $${usdAmount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH) to <@${recipient.userId}>?\n\nRecipient wallet: ${recipientWallet.slice(0, 6)}...${recipientWallet.slice(-4)}`,
                components: [
                    {
                        id: 'confirm',
                        component: {
                            case: 'button',
                            value: { label: '✅ Confirm' }
                        }
                    },
                    {
                        id: 'cancel',
                        component: {
                            case: 'button',
                            value: { label: '❌ Cancel' }
                        }
                    }
                ]
            }
        }, hexToBytes(userId as `0x${string}`))

    } catch (error) {
        console.error('[/tip] Error:', error)
        await handler.sendMessage(channelId, '❌ Failed to process tip request. Please try again.')
    }
})

// /tipsplit @user1 @user2 @user3 amount
bot.onSlashCommand('tipsplit', async (handler, event) => {
    const { args, mentions, channelId, userId, eventId } = event

    console.log('[/tipsplit] Received:', { args, mentions: mentions.length, userId })

    // Validate mentions
    if (mentions.length < 2) {
        console.log('[/tipsplit] Not enough mentions:', mentions.length)
        await handler.sendMessage(channelId, '❌ Please mention at least 2 users.\n**Usage:** `/tipsplit @user1 @user2 amount`')
        return
    }

    // Check if user is trying to include themselves
    const selfTip = mentions.find(m => m.userId === userId)
    if (selfTip) {
        await handler.sendMessage(channelId, '❌ You cannot include yourself in a tip split! 😅')
        return
    }

    // Parse amount in USD
    const totalUsd = parseAmountFromArgs(args)
    console.log('[/tipsplit] Parsed amount:', totalUsd, 'USD from args:', args)

    if (totalUsd === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/tipsplit @user1 @user2 amount`')
        return
    }

    if (totalUsd <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        return
    }

    const splitUsd = parseFloat((totalUsd / mentions.length).toFixed(2))

    try {
        // Get sender's wallet to check balance
        const senderWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!senderWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            return
        }

        // Convert total USD to ETH
        const totalEth = await usdToEth(totalUsd)
        const totalEthWei = parseEther(totalEth.toString())

        console.log('[/tipsplit] Converted:', totalUsd, 'USD →', totalEth, 'ETH')

        // Check if sender has enough balance
        const { hasEnough, balance } = await checkBalance(senderWallet as `0x${string}`, totalEthWei)

        if (!hasEnough) {
            const balanceUsd = (parseFloat(formatEther(balance)) * await getEthPrice()).toFixed(2)
            await handler.sendMessage(
                channelId,
                `❌ Insufficient balance!\n\n` +
                `**Required:** $${totalUsd.toFixed(2)} (~${totalEth.toFixed(6)} ETH)\n` +
                `**Your balance:** $${balanceUsd} (~${formatEther(balance)} ETH)\n\n` +
                `Please add more funds to your wallet.`
            )
            return
        }

        // Convert individual split amount to ETH
        const splitEth = await usdToEth(splitUsd)

        // Get wallets for all recipients
        const recipients = []
        for (const mention of mentions) {
            const wallet = await getSmartAccountFromUserId(bot, { userId: mention.userId })
            if (!wallet) {
                await handler.sendMessage(channelId, `❌ Unable to find wallet for <@${mention.userId}> (${mention.displayName})`)
                return
            }
            recipients.push({
                userId: mention.userId,
                displayName: mention.displayName,
                wallet: wallet as `0x${string}`,
                amount: splitEth // Store ETH amount
            })
        }

        // Store pending tip
        const requestId = `tipsplit-${eventId}`
        pendingTips.set(requestId, {
            recipients,
            totalAmount: totalEth // Store total ETH
        })

        // Build breakdown
        const breakdown = recipients
            .map(r => `  • $${splitUsd.toFixed(2)} (~${r.amount.toFixed(6)} ETH) → <@${r.userId}>`)
            .join('\n')

        // Send confirmation dialog
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `💸 Confirm Split Tip`,
                description: `Split $${totalUsd.toFixed(2)} (~${totalEth.toFixed(6)} ETH) between ${mentions.length} users:\n\n${breakdown}`,
                components: [
                    {
                        id: 'confirm',
                        component: {
                            case: 'button',
                            value: { label: '✅ Confirm' }
                        }
                    },
                    {
                        id: 'cancel',
                        component: {
                            case: 'button',
                            value: { label: '❌ Cancel' }
                        }
                    }
                ]
            }
        }, hexToBytes(userId as `0x${string}`))

    } catch (error) {
        console.error('Error in /tip-split:', error)
        await handler.sendMessage(channelId, '❌ Failed to process split tip request. Please try again.')
    }
})

// /donate amount
bot.onSlashCommand('donate', async (handler, event) => {
    const { args, channelId, userId, eventId } = event

    console.log('[/donate] Received:', { args, userId })

    // Parse amount in USD
    const usdAmount = parseAmountFromArgs(args)
    console.log('[/donate] Parsed amount:', usdAmount, 'USD from args:', args)

    if (usdAmount === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/donate amount`')
        return
    }

    if (usdAmount <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        return
    }

    try {
        // Get sender's wallet to check balance
        const senderWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!senderWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            return
        }

        // Convert USD to ETH
        const ethAmount = await usdToEth(usdAmount)
        const ethAmountWei = parseEther(ethAmount.toString())

        console.log('[/donate] Converted:', usdAmount, 'USD →', ethAmount, 'ETH')

        // Check if sender has enough balance
        const { hasEnough, balance } = await checkBalance(senderWallet as `0x${string}`, ethAmountWei)

        if (!hasEnough) {
            const balanceUsd = (parseFloat(formatEther(balance)) * await getEthPrice()).toFixed(2)
            await handler.sendMessage(
                channelId,
                `❌ Insufficient balance!\n\n` +
                `**Required:** $${usdAmount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH)\n` +
                `**Your balance:** $${balanceUsd} (~${formatEther(balance)} ETH)\n\n` +
                `Please add more funds to your wallet.`
            )
            return
        }

        // Store pending donation
        const requestId = `donate-${eventId}`
        pendingTips.set(requestId, {
            recipients: [{
                userId: bot.botId,
                displayName: 'TipsoBot',
                wallet: bot.appAddress as `0x${string}`,
                amount: ethAmount // Store ETH amount
            }],
            totalAmount: ethAmount
        })

        // Send confirmation dialog
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `❤️ Confirm Donation`,
                description: `Donate $${usdAmount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH) to support TipsoBot?\n\nYour support helps keep this bot running! 🙏`,
                components: [
                    {
                        id: 'confirm',
                        component: {
                            case: 'button',
                            value: { label: '✅ Confirm Donation' }
                        }
                    },
                    {
                        id: 'cancel',
                        component: {
                            case: 'button',
                            value: { label: '❌ Cancel' }
                        }
                    }
                ]
            }
        }, hexToBytes(userId as `0x${string}`))

    } catch (error) {
        console.error('Error in /donate:', error)
        await handler.sendMessage(channelId, '❌ Failed to process donation request. Please try again.')
    }
})

// /stats - global bot statistics
bot.onSlashCommand('stats', async (handler, event) => {
    const { channelId } = event

    try {
        const stats = await getGlobalStats()
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

// /leaderboard - top tippers and donators
bot.onSlashCommand('leaderboard', async (handler, { channelId }) => {
    try {
        const topTippers = await getTopTippers(5)
        const topDonators = await getTopDonators(5)

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

// /request amount description - create payment request
bot.onSlashCommand('request', async (handler, event) => {
    const { args, userId, channelId, eventId } = event

    // Check cooldown
    const canUse = await checkCooldown(userId, 'request', REQUEST_COOLDOWN)
    if (!canUse) {
        const remaining = await getRemainingCooldown(userId, 'request', REQUEST_COOLDOWN)
        await handler.sendMessage(
            channelId,
            `⏰ You can only create one payment request every 24 hours.\n\n` +
            `**Time remaining:** ${formatTimeRemaining(remaining)}`
        )
        return
    }

    // First arg is amount, rest is description
    const amountStr = args[0]
    const description = args.slice(1).join(' ')

    if (!amountStr) {
        await handler.sendMessage(channelId, '❌ Please provide an amount.\n**Usage:** `/request amount description`')
        return
    }

    const amount = parseFloat(amountStr)
    if (isNaN(amount) || amount <= 0) {
        await handler.sendMessage(channelId, '❌ Please provide a valid positive amount.')
        return
    }

    if (!description || description.trim().length === 0) {
        await handler.sendMessage(channelId, '❌ Please provide a description.\n**Usage:** `/request amount description`')
        return
    }

    try {
        // Get creator info
        const creatorWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!creatorWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            return
        }

        // Create unique request ID
        const requestId = `req-${eventId}`

        // Store payment request in database
        await createPaymentRequest({
            id: requestId,
            creatorId: userId,
            creatorName: 'User', // Will be updated when they contribute
            amount,
            description: description.trim(),
            channelId
        })

        // Update cooldown
        await updateCooldown(userId, 'request')

        console.log('[/request] Created payment request:', requestId, 'amount:', amount, 'description:', description)

        // Send request message
        await handler.sendMessage(
            channelId,
            `**💰 Payment Request Created**\n\n` +
                `**Goal:** $${amount.toFixed(2)}\n` +
                `**Description:** ${description.trim()}\n` +
                `**Collected:** $0.00 / $${amount.toFixed(2)}\n` +
                `**Progress:** ▱▱▱▱▱▱▱▱▱▱ 0%\n\n` +
                `To contribute, use: \`/contribute ${requestId} amount\`\n` +
                `Example: \`/contribute ${requestId} 5\``
        )

    } catch (error) {
        console.error('[/request] Error:', error)
        await handler.sendMessage(channelId, '❌ Failed to create payment request. Please try again.')
    }
})

// /contribute requestId amount - contribute to payment request
bot.onSlashCommand('contribute', async (handler, event) => {
    const { args, userId, channelId, eventId } = event

    const requestId = args[0]
    const amountStr = args[1]

    if (!requestId) {
        await handler.sendMessage(channelId, '❌ Please provide a request ID.\n**Usage:** `/contribute requestId amount`')
        return
    }

    if (!amountStr) {
        await handler.sendMessage(channelId, '❌ Please provide an amount.\n**Usage:** `/contribute requestId amount`')
        return
    }

    const amount = parseFloat(amountStr)
    if (isNaN(amount) || amount <= 0) {
        await handler.sendMessage(channelId, '❌ Please provide a valid positive amount.')
        return
    }

    try {
        // Find payment request in database
        const paymentRequest = await getPaymentRequest(requestId)
        if (!paymentRequest) {
            await handler.sendMessage(channelId, '❌ Payment request not found. Please check the request ID.')
            return
        }

        // Get contributor wallet
        const contributorWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!contributorWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            return
        }

        // Get creator wallet
        const creatorWallet = await getSmartAccountFromUserId(bot, { userId: paymentRequest.creator_id })
        if (!creatorWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find creator wallet.')
            return
        }

        // Convert USD to ETH
        const ethAmount = await usdToEth(amount)
        const ethAmountWei = parseEther(ethAmount.toString())

        console.log('[/contribute] Converted:', amount, 'USD →', ethAmount, 'ETH')

        // Check if sender has enough balance
        const { hasEnough, balance } = await checkBalance(contributorWallet as `0x${string}`, ethAmountWei)

        if (!hasEnough) {
            const balanceUsd = (parseFloat(formatEther(balance)) * await getEthPrice()).toFixed(2)
            await handler.sendMessage(
                channelId,
                `❌ Insufficient balance!\n\n` +
                `**Required:** $${amount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH)\n` +
                `**Your balance:** $${balanceUsd} (~${formatEther(balance)} ETH)\n\n` +
                `Please add more funds to your wallet.`
            )
            return
        }

        // Store pending contribution in database (will be processed after transaction confirmation)
        const contributionId = `contrib-${eventId}`
        await savePendingTransaction(contributionId, 'contribute', userId, {
            requestId,
            creatorId: paymentRequest.creator_id,
            creatorName: paymentRequest.creator_name,
            creatorWallet,
            contributorId: userId,
            contributionUsd: amount,
            ethAmount,
            channelId
        })

        console.log('[/contribute] Sending confirmation for contribution to:', requestId)

        // Send confirmation dialog
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: contributionId,
                title: `💰 Confirm Contribution`,
                description: `Contribute $${amount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH) to:\n\n"${paymentRequest.description}"\n\nCreated by: <@${paymentRequest.creator_id}>`,
                components: [
                    {
                        id: 'confirm',
                        component: {
                            case: 'button',
                            value: { label: '✅ Confirm' }
                        }
                    },
                    {
                        id: 'cancel',
                        component: {
                            case: 'button',
                            value: { label: '❌ Cancel' }
                        }
                    }
                ]
            }
        }, hexToBytes(userId as `0x${string}`))

    } catch (error) {
        console.error('[/contribute] Error:', error)
        await handler.sendMessage(channelId, '❌ Failed to process contribution. Please try again.')
    }
})

// Handle interaction responses (button clicks and transaction confirmations)
bot.onInteractionResponse(async (handler, event) => {
    const contentCase = event.response.payload.content?.case
    console.log('[onInteractionResponse] Received:', contentCase)

    if (contentCase === 'form') {
        // Handle button clicks (confirm/cancel)
        await handleFormResponse(handler, event, pendingTips, getEthPrice)
    } else if (contentCase === 'transaction') {
        // Handle transaction confirmations
        await handleTransactionResponse(handler, event, getEthPrice)
    }
})

// Handle direct tips to the bot (like using Towns native tip feature)
bot.onTip(async (handler, event) => {
    const { receiverAddress, amount, channelId } = event

    // Check if tip is for the bot
    if (receiverAddress.toLowerCase() === bot.appAddress.toLowerCase()) {
        const ethAmount = parseFloat(formatUnits(amount, ETH_DECIMALS))
        const ethPrice = await getEthPrice()
        const usdAmount = (ethAmount * ethPrice).toFixed(2)

        await handler.sendMessage(
            channelId,
            `❤️ Thank you for the tip! Received ~$${usdAmount} (${ethAmount.toFixed(6)} ETH)! 🙏`
        )
    }
})

// Initialize database before starting bot
async function startBot() {
    try {
        console.log('[Bot] Initializing database...')
        await initDatabase()

        console.log('[Bot] Starting bot...')
        const app = bot.start()

        // Health check route
        app.get('/', (c) => c.text('TipsoBot is running! 💸'))

        // Webhook route for Towns
        app.post('/webhook', async (c) => {
            // Get the webhook body
            const body = await c.req.json()
            console.log('Webhook received:', body)

            // Return 200 so Towns knows we received it
            return c.json({ ok: true }, 200)
        })

        // Cleanup old pending transactions every hour
        setInterval(async () => {
            try {
                console.log('[Cleanup] Running cleanup of old pending transactions...')
                await cleanupOldTransactions()
            } catch (error) {
                console.error('[Cleanup] Error:', error)
            }
        }, 60 * 60 * 1000) // 1 hour

        // Graceful shutdown
        const shutdown = async (signal: string) => {
            console.log(`\n[Bot] Received ${signal}, shutting down gracefully...`)
            try {
                await closeDatabase()
                console.log('[Bot] Database connection closed')
                process.exit(0)
            } catch (error) {
                console.error('[Bot] Error during shutdown:', error)
                process.exit(1)
            }
        }

        process.on('SIGTERM', () => shutdown('SIGTERM'))
        process.on('SIGINT', () => shutdown('SIGINT'))

        console.log('[Bot] Bot started successfully!')
        return app
    } catch (error) {
        console.error('[Bot] Fatal error during startup:', error)
        process.exit(1)
    }
}

export default startBot()
