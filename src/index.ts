import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
import { parseUnits, hexToBytes, formatUnits, parseEther, formatEther, isAddress } from 'viem'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { execute } from 'viem/experimental/erc7821'
import { waitForTransactionReceipt } from 'viem/actions'
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

// Helper function to parse recipients (mentions + wallet addresses)
type Recipient = {
    type: 'mention' | 'address'
    userId?: string
    displayName?: string
    wallet: `0x${string}`
}

async function parseRecipients(
    args: string[],
    mentions: Array<{ userId: string; displayName: string }>
): Promise<{ recipients: Recipient[], errors: string[] }> {
    const recipients: Recipient[] = []
    const errors: string[] = []
    const seenWallets = new Set<string>()

    // Add mentions
    for (const mention of mentions) {
        try {
            const wallet = await getSmartAccountFromUserId(bot, { userId: mention.userId })
            if (!wallet) {
                errors.push(`Unable to find wallet for @${mention.displayName}`)
                continue
            }
            const walletLower = wallet.toLowerCase()
            if (seenWallets.has(walletLower)) {
                errors.push(`Duplicate recipient: @${mention.displayName}`)
                continue
            }
            seenWallets.add(walletLower)
            recipients.push({
                type: 'mention',
                userId: mention.userId,
                displayName: mention.displayName,
                wallet: wallet as `0x${string}`
            })
        } catch (error) {
            errors.push(`Error resolving @${mention.displayName}`)
        }
    }

    // Add direct wallet addresses from args
    for (const arg of args) {
        if (arg.startsWith('0x') && isAddress(arg)) {
            const walletLower = arg.toLowerCase()
            if (seenWallets.has(walletLower)) {
                errors.push(`Duplicate recipient: ${arg.slice(0, 6)}...${arg.slice(-4)}`)
                continue
            }
            seenWallets.add(walletLower)
            recipients.push({
                type: 'address',
                wallet: arg as `0x${string}`
            })
        }
    }

    return { recipients, errors }
}

bot.onSlashCommand('help', async (handler, { channelId }) => {
    debugLog('/help', 'START')
    trackRpcCall()
    
    const ethPrice = await getEthPrice()

    await handler.sendMessage(
        channelId,
        `**TipsoBot - Send $ tips on Base** 💸\n\n` +
            `**Tipping:**\n` +
            `• \`/tip @user amount\` - Send to Towns user\n` +
            `• \`/tip 0x... amount\` - Send to wallet address\n` +
            `• \`/tipsplit @user1 @user2 0x... amount\` - Split equally (one signature!)\n` +
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
            `• Current ETH price: $${ethPrice.toFixed(2)}\n` +
            `• tipsplit uses bot batch - only ONE signature! ⚡\n`
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

// Simple message responses
bot.onMessage(async (handler, event) => {
    const { message, channelId, eventId, createdAt, isMentioned } = event
    const lowerMsg = message.toLowerCase()

    debugLog('onMessage', 'Received message', {
        isMentioned,
        hasKeywords: lowerMsg.includes('hello') || lowerMsg.includes('ping')
    })
    trackRpcCall()

    if (isMentioned) {
        await handler.sendMessage(
            channelId,
            '👋 Hi! I help you send $ tips (auto-converted to ETH on Base).\n\nType `/help` to see all available commands!'
        )
        trackRpcSuccess()
        return
    }

    if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
        await handler.sendMessage(channelId, 'Hello there! 👋 Type `/help` to see what I can do!')
        trackRpcSuccess()
        return
    }

    if (lowerMsg.includes('ping')) {
        const latency = new Date().getTime() - createdAt.getTime()
        await handler.sendMessage(channelId, `Pong! 🏓 Latency: ${latency}ms`)
        trackRpcSuccess()
        return
    }

    if (lowerMsg.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        trackRpcSuccess()
        return
    }
    
    trackRpcSuccess()
})

bot.onReaction(async (handler, { reaction, channelId }) => {
    debugLog('onReaction', 'Received reaction', { reaction })
    trackRpcCall()
    
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
    }
    
    trackRpcSuccess()
})

// /tip @username amount OR /tip 0x... amount
bot.onSlashCommand('tip', async (handler, event) => {
    const { args, mentions, channelId, userId, eventId, spaceId } = event

    debugLog('/tip', 'START', { userId, mentions: mentions.length, args })
    trackRpcCall()

    const { recipients, errors } = await parseRecipients(args, mentions)

    if (errors.length > 0) {
        await handler.sendMessage(channelId, `❌ Errors:\n${errors.join('\n')}`)
        trackRpcSuccess()
        return
    }

    if (recipients.length === 0) {
        debugLog('/tip', 'No recipients found')
        await handler.sendMessage(
            channelId,
            '❌ Please mention a user or provide a wallet address.\n**Usage:** `/tip @user amount` or `/tip 0x... amount`'
        )
        trackRpcSuccess()
        return
    }

    if (recipients.length > 1) {
        debugLog('/tip', 'Too many recipients', { count: recipients.length })
        await handler.sendMessage(channelId, '❌ Please specify only ONE recipient. Use `/tipsplit` for multiple.')
        trackRpcSuccess()
        return
    }

    const recipient = recipients[0]

    if (recipient.userId === userId) {
        debugLog('/tip', 'Self-tip attempt')
        await handler.sendMessage(channelId, '❌ You cannot tip yourself! 😅')
        trackRpcSuccess()
        return
    }

    const usdAmount = parseAmountFromArgs(args)
    debugLog('/tip', 'Parsed amount', { usdAmount, args })

    if (usdAmount === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/tip @user amount`')
        trackRpcSuccess()
        return
    }

    if (usdAmount <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        trackRpcSuccess()
        return
    }

    try {
        debugLog('/tip', 'Getting sender wallet')
        const senderWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!senderWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            trackRpcSuccess()
            return
        }

        const ethAmount = await usdToEth(usdAmount)
        const ethAmountWei = parseEther(ethAmount.toString())

        debugLog('/tip', 'USD to ETH conversion', { usd: usdAmount, eth: ethAmount })

        const { hasEnough, balance } = await checkBalance(senderWallet as `0x${string}`, ethAmountWei)

        if (!hasEnough) {
            const balanceUsd = (parseFloat(formatEther(balance)) * await getEthPrice()).toFixed(2)
            debugLog('/tip', 'Insufficient balance', { required: usdAmount, balance: balanceUsd })
            await handler.sendMessage(
                channelId,
                `❌ Insufficient balance!\n\n` +
                `**Required:** $${usdAmount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH)\n` +
                `**Your balance:** $${balanceUsd} (~${formatEther(balance)} ETH)\n\n` +
                `Please add more funds to your wallet.`
            )
            trackRpcSuccess()
            return
        }

        const recipientDisplay = recipient.type === 'mention'
            ? `<@${recipient.userId}>`
            : `${recipient.wallet.slice(0, 6)}...${recipient.wallet.slice(-4)}`

        const requestId = `tip-${eventId}`
        debugLog('/tip', 'Sending confirmation dialog', { requestId })
        
        const sentMessage = await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `💸 Confirm Tip`,
                description: `Send $${usdAmount.toFixed(2)} (~${ethAmount.toFixed(6)} ETH) to ${recipientDisplay}?\n\nRecipient wallet: ${recipient.wallet.slice(0, 6)}...${recipient.wallet.slice(-4)}`,
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

        const messageId = sentMessage?.eventId || sentMessage?.id || eventId
        debugLog('/tip', 'Confirmation sent, saving to DB', { messageId })

        await savePendingTransaction(spaceId, requestId, 'tip', userId, {
            recipientId: recipient.userId,
            recipientName: recipient.displayName,
            recipientWallet: recipient.wallet,
            usdAmount,
            ethAmount,
            channelId
        }, messageId, channelId)

        debugLog('/tip', 'END - Success')
        trackRpcSuccess()

    } catch (error) {
        debugError('/tip', 'Error processing tip', error)
        trackRpcError(error)
        await handler.sendMessage(channelId, '❌ Failed to process tip request. Please try again.')
    }
})

// /tipsplit @user1 @user2 0x... amount - NEW: Single signature via bot!
bot.onSlashCommand('tipsplit', async (handler, event) => {
    const { args, mentions, channelId, userId, eventId, spaceId } = event

    debugLog('/tipsplit', 'START', { userId, mentions: mentions.length, args })
    trackRpcCall()

    const { recipients, errors } = await parseRecipients(args, mentions)

    if (errors.length > 0) {
        await handler.sendMessage(channelId, `❌ Errors:\n${errors.join('\n')}`)
        trackRpcSuccess()
        return
    }

    if (recipients.length < 2) {
        debugLog('/tipsplit', 'Not enough recipients', { count: recipients.length })
        await handler.sendMessage(
            channelId,
            '❌ Please specify at least 2 recipients.\n**Usage:** `/tipsplit @user1 @user2 amount`'
        )
        trackRpcSuccess()
        return
    }

    const selfTip = recipients.find(r => r.userId === userId)
    if (selfTip) {
        debugLog('/tipsplit', 'User included themselves')
        await handler.sendMessage(channelId, '❌ You cannot include yourself in a tip split! 😅')
        trackRpcSuccess()
        return
    }

    const totalUsd = parseAmountFromArgs(args)
    debugLog('/tipsplit', 'Parsed amount', { totalUsd, args })

    if (totalUsd === null) {
        await handler.sendMessage(
            channelId,
            '❌ Please provide a valid amount.\n**Usage:** `/tipsplit @user1 @user2 amount`'
        )
        trackRpcSuccess()
        return
    }

    if (totalUsd <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        trackRpcSuccess()
        return
    }

    const splitUsd = parseFloat((totalUsd / recipients.length).toFixed(2))
    const splitEth = await usdToEth(splitUsd)

    try {
        debugLog('/tipsplit', 'Getting sender wallet')
        const senderWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!senderWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            trackRpcSuccess()
            return
        }

        const totalEth = await usdToEth(totalUsd)
        const totalEthWei = parseEther(totalEth.toString())

        debugLog('/tipsplit', 'Converted', { totalUsd, totalEth })

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
            trackRpcSuccess()
            return
        }

        const breakdown = recipients
            .map(r => {
                const display = r.type === 'mention'
                    ? `<@${r.userId}>`
                    : `${r.wallet.slice(0, 6)}...${r.wallet.slice(-4)}`
                return `  • $${splitUsd.toFixed(2)} (~${splitEth.toFixed(6)} ETH) → ${display}`
            })
            .join('\n')

        // NEW: User sends to BOT, bot does batch!
        const requestId = `tipsplit-${eventId}`
        debugLog('/tipsplit', 'Requesting payment to bot', { requestId })

        const sentMessage = await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `💸 Confirm Split Tip`,
                description: `Send $${totalUsd.toFixed(2)} (~${totalEth.toFixed(6)} ETH) to TipsoBot.\n\nBot will split between ${recipients.length} recipients:\n\n${breakdown}\n\n⚡ ONE signature, bot handles distribution!`,
                components: [
                    {
                        id: 'confirm',
                        component: {
                            case: 'button',
                            value: { label: '✅ Confirm & Send to Bot' }
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

        const messageId = sentMessage?.eventId || sentMessage?.id || eventId
        
        debugLog('/tipsplit', 'Saving to DB', { requestId, messageId })
        await savePendingTransaction(spaceId, requestId, 'tipsplit', userId, {
            recipients: recipients.map(r => ({
                userId: r.userId,
                displayName: r.displayName,
                wallet: r.wallet,
                usdAmount: splitUsd,
                ethAmount: splitEth
            })),
            totalUsd,
            totalEth,
            channelId
        }, messageId, channelId)

        debugLog('/tipsplit', 'END - Success')
        trackRpcSuccess()

    } catch (error) {
        debugError('/tipsplit', 'Error', error)
        trackRpcError(error)
        await handler.sendMessage(channelId, '❌ Failed to process split tip request. Please try again.')
    }
})

// /donate amount
bot.onSlashCommand('donate', async (handler, event) => {
    const { args, channelId, userId, eventId, spaceId } = event

    debugLog('/donate', 'START', { userId, args })
    trackRpcCall()

    const usdAmount = parseAmountFromArgs(args)
    debugLog('/donate', 'Parsed amount', { usdAmount, args })

    if (usdAmount === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/donate amount`')
        trackRpcSuccess()
        return
    }

    if (usdAmount <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        trackRpcSuccess()
        return
    }

    try {
        debugLog('/donate', 'Getting sender wallet')
        const senderWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!senderWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            trackRpcSuccess()
            return
        }

        const ethAmount = await usdToEth(usdAmount)
        const ethAmountWei = parseEther(ethAmount.toString())

        debugLog('/donate', 'Converted', { usdAmount, ethAmount })

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
            trackRpcSuccess()
            return
        }

        debugLog('/donate', 'Sending confirmation dialog...')
        const sentMessage = await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: `donate-${eventId}`,
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
        debugLog('/donate', 'Confirmation dialog sent')

        const requestId = `donate-${eventId}`
        const messageId = sentMessage?.eventId || sentMessage?.id || eventId
        
        debugLog('/donate', 'Saving to DB', { requestId, messageId })
        await savePendingTransaction(spaceId, requestId, 'donate', userId, {
            usdAmount,
            ethAmount,
            botAddress: bot.appAddress,
            channelId
        }, messageId, channelId)

        debugLog('/donate', 'END - Success')
        trackRpcSuccess()

    } catch (error) {
        debugError('/donate', 'Error', error)
        trackRpcError(error)
        await handler.sendMessage(channelId, '❌ Failed to process donation request. Please try again.')
    }
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

// /request amount description
bot.onSlashCommand('request', async (handler, event) => {
    const { args, userId, channelId, eventId, spaceId } = event

    debugLog('/request', 'START', { userId, args })
    trackRpcCall()

    const canUse = await checkCooldown(spaceId, userId, 'request', REQUEST_COOLDOWN)
    if (!canUse) {
        const remaining = await getRemainingCooldown(spaceId, userId, 'request', REQUEST_COOLDOWN)
        debugLog('/request', 'Cooldown active', { remaining })
        await handler.sendMessage(
            channelId,
            `⏰ You can only create one payment request every 24 hours.\n\n` +
            `**Time remaining:** ${formatTimeRemaining(remaining)}`
        )
        trackRpcSuccess()
        return
    }

    const amountStr = args[0]
    const description = args.slice(1).join(' ')

    if (!amountStr) {
        await handler.sendMessage(channelId, '❌ Please provide an amount.\n**Usage:** `/request amount description`')
        trackRpcSuccess()
        return
    }

    const amount = parseFloat(amountStr)
    if (isNaN(amount) || amount <= 0) {
        await handler.sendMessage(channelId, '❌ Please provide a valid positive amount.')
        trackRpcSuccess()
        return
    }

    if (!description || description.trim().length === 0) {
        await handler.sendMessage(channelId, '❌ Please provide a description.\n**Usage:** `/request amount description`')
        trackRpcSuccess()
        return
    }

    try {
        debugLog('/request', 'Getting creator wallet')
        const creatorWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!creatorWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            trackRpcSuccess()
            return
        }

        const requestId = `req-${eventId}`

        debugLog('/request', 'Creating payment request in DB', { requestId, amount })
        await createPaymentRequest({
            id: requestId,
            spaceId,
            creatorId: userId,
            creatorName: 'User',
            amount,
            description: description.trim(),
            channelId
        })

        await updateCooldown(spaceId, userId, 'request')

        debugLog('/request', 'Sending success message')
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

        debugLog('/request', 'END - Success')
        trackRpcSuccess()

    } catch (error) {
        debugError('/request', 'Error', error)
        trackRpcError(error)
        await handler.sendMessage(channelId, '❌ Failed to create payment request. Please try again.')
    }
})

// /contribute requestId amount
bot.onSlashCommand('contribute', async (handler, event) => {
    const { args, userId, channelId, eventId, spaceId } = event

    debugLog('/contribute', 'START', { userId, args })
    trackRpcCall()

    const requestId = args[0]
    const amountStr = args[1]

    if (!requestId) {
        await handler.sendMessage(channelId, '❌ Please provide a request ID.\n**Usage:** `/contribute requestId amount`')
        trackRpcSuccess()
        return
    }

    if (!amountStr) {
        await handler.sendMessage(channelId, '❌ Please provide an amount.\n**Usage:** `/contribute requestId amount`')
        trackRpcSuccess()
        return
    }

    const amount = parseFloat(amountStr)
    if (isNaN(amount) || amount <= 0) {
        await handler.sendMessage(channelId, '❌ Please provide a valid positive amount.')
        trackRpcSuccess()
        return
    }

    try {
        debugLog('/contribute', 'Finding payment request in DB', { requestId })
        const paymentRequest = await getPaymentRequest(requestId)
        if (!paymentRequest) {
            await handler.sendMessage(channelId, '❌ Payment request not found. Please check the request ID.')
            trackRpcSuccess()
            return
        }

        if (paymentRequest.is_completed) {
            debugLog('/contribute', 'Request already completed')
            await handler.sendMessage(
                channelId,
                `❌ This payment request is already completed! 🎉\n\n` +
                `<@${paymentRequest.creator_id}> is happy! Goal was reached. 😊`,
                { mentions: [{ userId: paymentRequest.creator_id, displayName: paymentRequest.creator_name }] }
            )
            trackRpcSuccess()
            return
        }

        debugLog('/contribute', 'Getting contributor wallet')
        const contributorWallet = await getSmartAccountFromUserId(bot, { userId: userId })
        if (!contributorWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find your wallet.')
            trackRpcSuccess()
            return
        }

        debugLog('/contribute', 'Getting creator wallet')
        const creatorWallet = await getSmartAccountFromUserId(bot, { userId: paymentRequest.creator_id })
        if (!creatorWallet) {
            await handler.sendMessage(channelId, '❌ Unable to find creator wallet.')
            trackRpcSuccess()
            return
        }

        const ethAmount = await usdToEth(amount)
        const ethAmountWei = parseEther(ethAmount.toString())

        debugLog('/contribute', 'Converted', { amount, ethAmount })

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
            trackRpcSuccess()
            return
        }

        debugLog('/contribute', 'Sending confirmation dialog')
        const sentMessage = await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: `contrib-${eventId}`,
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

        const contributionId = `contrib-${eventId}`
        const messageId = sentMessage?.eventId || sentMessage?.id || eventId
        
        debugLog('/contribute', 'Saving to DB', { contributionId, messageId })
        await savePendingTransaction(spaceId, contributionId, 'contribute', userId, {
            requestId,
            creatorId: paymentRequest.creator_id,
            creatorName: paymentRequest.creator_name,
            creatorWallet,
            contributorId: userId,
            contributionUsd: amount,
            ethAmount,
            channelId
        }, messageId, channelId)

        debugLog('/contribute', 'END - Success')
        trackRpcSuccess()

    } catch (error) {
        debugError('/contribute', 'Error', error)
        trackRpcError(error)
        await handler.sendMessage(channelId, '❌ Failed to process contribution. Please try again.')
    }
})

// Handle interaction responses
bot.onInteractionResponse(async (handler, event) => {
    const contentCase = event.response.payload.content?.case
    
    debugLog('onInteractionResponse', 'Received interaction', {
        contentCase,
        eventId: event.eventId,
        userId: event.userId
    })
    trackRpcCall()

    if (contentCase === 'form') {
        await handleFormResponse(handler, event, getEthPrice, bot)
    } else if (contentCase === 'transaction') {
        await handleTransactionResponse(handler, event, getEthPrice, bot)
    } else {
        debugLog('onInteractionResponse', 'Unknown content case', { contentCase })
    }
    
    trackRpcSuccess()
})

// Handle direct tips to the bot + tipsplit distribution!
bot.onTip(async (handler, event) => {
    debugLog('onTip', 'Received tip', {
        receiverAddress: event.receiverAddress.slice(0, 10) + '...',
        amount: formatEther(event.amount)
    })
    trackRpcCall()
    
    const { receiverAddress, amount, channelId, messageId, userId: senderId } = event

    // Check if tip is for the bot
    if (receiverAddress.toLowerCase() !== bot.appAddress.toLowerCase()) {
        debugLog('onTip', 'Tip not for bot, ignoring')
        trackRpcSuccess()
        return
    }

    const ethAmount = parseFloat(formatUnits(amount, ETH_DECIMALS))
    const ethPrice = await getEthPrice()
    const usdAmount = ethAmount * ethPrice

    debugLog('onTip', 'Tip is for bot', { ethAmount, usdAmount })

    // Check if this is a tipsplit payment (find pending transaction)
    // messageId from onTip is the eventId from /tipsplit command
    const tipsplitId = `tipsplit-${messageId}`
    const pendingTx = await getPendingTransaction(tipsplitId)

    if (pendingTx && pendingTx.type === 'tipsplit') {
        debugLog('onTip', 'This is a tipsplit payment!', { tipsplitId })
        
        try {
            const data = pendingTx.data
            const recipients = data.recipients

            debugLog('onTip', 'Building batch calls', { recipientCount: recipients.length })

            // Build batch calls for execute()
            const calls = recipients.map((r: any) => ({
                to: r.wallet as `0x${string}`,
                value: parseEther(r.ethAmount.toString()),
                data: '0x' as `0x${string}`
            }))

            debugLog('onTip', 'Executing batch transfer...')

            // Execute batch transfer from bot
            const hash = await execute(bot.viem, {
                address: bot.appAddress as `0x${string}`,
                account: bot.viem.account,
                calls
            })

            debugLog('onTip', 'Batch transaction sent', { hash })

            // Wait for confirmation
            await waitForTransactionReceipt(bot.viem, { hash })

            debugLog('onTip', 'Batch transaction confirmed!')

            // Update stats
            await updateGlobalStats(data.spaceId || pendingTx.space_id, {
                tipsVolume: data.totalUsd,
                tipsCount: 1
            })

            await upsertUserStats(data.spaceId || pendingTx.space_id, senderId, senderId, {
                sentAmount: data.totalUsd,
                tipsSent: 1,
                tipsSentAmount: data.totalUsd
            })

            for (const recipient of recipients) {
                if (recipient.userId) {
                    await upsertUserStats(
                        data.spaceId || pendingTx.space_id,
                        recipient.userId,
                        recipient.displayName || 'User',
                        {
                            receivedAmount: recipient.usdAmount,
                            tipsReceived: 1,
                            tipsReceivedAmount: recipient.usdAmount
                        }
                    )
                }
            }

            // Send success message
            const recipientList = recipients
                .map((r: any) => r.userId ? `<@${r.userId}>` : `${r.wallet.slice(0, 6)}...${r.wallet.slice(-4)}`)
                .join(', ')

            const mentions = recipients
                .filter((r: any) => r.userId)
                .map((r: any) => ({ userId: r.userId, displayName: r.displayName || 'User' }))

            mentions.push({ userId: senderId, displayName: 'Sender' })

            await handler.sendMessage(
                data.channelId,
                `💸 <@${senderId}> sent ~$${data.totalUsd.toFixed(2)} (${data.totalEth.toFixed(6)} ETH) split between ${recipientList} in ONE transaction! ⚡\n\n🔗 [View on BaseScan](https://basescan.org/tx/${hash})`,
                { mentions }
            )

            // Clean up pending transaction
            await deletePendingTransaction(tipsplitId)

            debugLog('onTip', 'Tipsplit completed successfully!')

        } catch (error) {
            debugError('onTip', 'Error processing tipsplit', error)
            await handler.sendMessage(
                pendingTx.data.channelId,
                `❌ Failed to distribute tips. Please contact support. Funds are safe in bot wallet.`
            )
        }

    } else {
        // Regular donation to bot
        debugLog('onTip', 'Regular donation to bot')
        await handler.sendMessage(
            channelId,
            `❤️ Thank you for the tip! Received ~$${usdAmount.toFixed(2)} (${ethAmount.toFixed(6)} ETH)! 🙏`
        )
    }
    
    trackRpcSuccess()
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

app.use('/webhook', async (c, next) => {
    console.log('=== WEBHOOK DEBUG ===')
    console.log('Headers:', c.req.header())
    console.log('Method:', c.req.method)
    console.log('URL:', c.req.url)
    await next()
})

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
