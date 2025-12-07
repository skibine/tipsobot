import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
import { parseUnits, hexToBytes, formatUnits, parseEther, formatEther } from 'viem'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import commands from './commands'

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
        const data = await response.json()
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
            `**Commands:**\n` +
            `• \`/tip @username amount\` - Send money to a user\n` +
            `• \`/tipsplit @user1 @user2 amount\` - Split amount equally\n` +
            `• \`/donate amount\` - Support the bot\n` +
            `• \`/help\` - Show this message\n` +
            `• \`/time\` - Current server time\n\n` +
            `**Examples:**\n` +
            `• \`/tip @alice 5\` - Send $5 to Alice\n` +
            `• \`/tipsplit @bob @charlie 10\` - Send $5 each\n` +
            `• \`/donate 2\` - Donate $2 to the bot\n\n` +
            `**Info:**\n` +
            `• All amounts are in USD ($)\n` +
            `• Converted to ETH automatically\n` +
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

// Handle interaction responses (button clicks)
bot.onInteractionResponse(async (handler, event) => {
    console.log('[onInteractionResponse] Received:', event.response.payload.content?.case)

    if (event.response.payload.content?.case !== 'form') return

    const form = event.response.payload.content.value
    const tipData = pendingTips.get(form.requestId)

    console.log('[onInteractionResponse] Request ID:', form.requestId, 'Found data:', !!tipData)

    if (!tipData) return

    // Clean up stored data
    pendingTips.delete(form.requestId)

    // Check which button was clicked
    const clickedButton = form.components.find(c => c.component.case === 'button')
    console.log('[onInteractionResponse] Button clicked:', clickedButton?.id)

    if (!clickedButton) return

    if (clickedButton.id === 'cancel') {
        await handler.sendMessage(event.channelId, '❌ Cancelled.')
        return
    }

    if (clickedButton.id === 'confirm') {
        try {
            console.log('[onInteractionResponse] Confirming, recipients:', tipData.recipients.length)

            // Send transaction request for each recipient
            for (const recipient of tipData.recipients) {
                const amountWei = parseEther(recipient.amount.toString())

                console.log('[onInteractionResponse] Sending tx for:', recipient.userId, 'amount:', recipient.amount, 'ETH')
                console.log('[onInteractionResponse] Recipient wallet:', recipient.wallet)
                console.log('[onInteractionResponse] Amount in wei:', amountWei.toString())
                console.log('[onInteractionResponse] Chain:', 'Base (8453)')

                // Calculate USD value
                const ethPrice = await getEthPrice()
                const usdValue = (recipient.amount * ethPrice).toFixed(2)

                // Send transaction request to user (native ETH transfer)
                await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}-${recipient.userId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Transfer ~$${usdValue} (${recipient.amount.toFixed(6)} ETH) on Base\n\nTo: ${recipient.wallet.slice(0, 6)}...${recipient.wallet.slice(-4)}\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453', // Base
                                to: recipient.wallet,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))

                console.log('[onInteractionResponse] Transaction request sent for:', recipient.userId)
            }

            // Send success message with USD values
            const ethPrice = await getEthPrice()
            const totalUsd = (tipData.totalAmount * ethPrice).toFixed(2)

            if (form.requestId.startsWith('donate-')) {
                await handler.sendMessage(event.channelId, `❤️ Thank you for your ~$${totalUsd} (${tipData.totalAmount.toFixed(6)} ETH) donation! Your support means everything! 🙏`)
            } else if (form.requestId.startsWith('tipsplit-')) {
                const recipientList = tipData.recipients
                    .map(r => `<@${r.userId}>`)
                    .join(', ')
                await handler.sendMessage(
                    event.channelId,
                    `💸 Sending ~$${totalUsd} (${tipData.totalAmount.toFixed(6)} ETH) split between ${recipientList}!`,
                    { mentions: tipData.recipients.map(r => ({ userId: r.userId, displayName: r.displayName })) }
                )
            } else {
                const recipient = tipData.recipients[0]
                await handler.sendMessage(
                    event.channelId,
                    `💸 Sending ~$${totalUsd} (${tipData.totalAmount.toFixed(6)} ETH) to <@${recipient.userId}>!`,
                    { mentions: [{ userId: recipient.userId, displayName: recipient.displayName }] }
                )
            }

        } catch (error) {
            console.error('Error sending transaction:', error)
            await handler.sendMessage(event.channelId, '❌ Failed to send transaction request. Please try again.')
        }
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

export default app
