import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
import { parseUnits, hexToBytes, formatUnits, parseEther } from 'viem'
import commands from './commands'

// ETH on Base - native currency
const ETH_DECIMALS = 18

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
    await handler.sendMessage(
        channelId,
        '**TipsoBot - Send ETH tips on Base** 💸\n\n' +
            '**Commands:**\n' +
            '• `/tip @username amount` - Send ETH to a user\n' +
            '• `/tipsplit @user1 @user2 amount` - Split amount equally\n' +
            '• `/donate amount` - Support the bot with ETH\n' +
            '• `/help` - Show this message\n' +
            '• `/time` - Current server time\n\n' +
            '**Examples:**\n' +
            '• `/tip @alice 0.001` - Send 0.001 ETH to Alice\n' +
            '• `/tipsplit @bob @charlie 0.002` - Send 0.001 ETH each\n' +
            '• `/donate 0.0005` - Donate 0.0005 ETH to the bot\n'
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
            '👋 Hi! I help you send ETH tips on Base.\n\nType `/help` to see all available commands!'
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

    // Parse amount
    const amount = parseAmountFromArgs(args)
    console.log('[/tip] Parsed amount:', amount, 'from args:', args)

    if (amount === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/tip @username amount`')
        return
    }

    if (amount <= 0) {
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

        // Store pending tip
        const requestId = `tip-${eventId}`
        pendingTips.set(requestId, {
            recipients: [{
                userId: recipient.userId,
                displayName: recipient.displayName,
                wallet: recipientWallet as `0x${string}`,
                amount
            }],
            totalAmount: amount
        })

        console.log('[/tip] Sending confirmation dialog')

        // Send confirmation dialog
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `💸 Confirm Tip`,
                description: `Send ${amount} ETH to <@${recipient.userId}>?\n\nRecipient wallet: ${recipientWallet.slice(0, 6)}...${recipientWallet.slice(-4)}`,
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

    // Parse amount
    const totalAmount = parseAmountFromArgs(args)
    console.log('[/tipsplit] Parsed amount:', totalAmount, 'from args:', args)

    if (totalAmount === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/tipsplit @user1 @user2 amount`')
        return
    }

    if (totalAmount <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        return
    }

    const splitAmount = parseFloat((totalAmount / mentions.length).toFixed(6))

    try {
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
                amount: splitAmount
            })
        }

        // Store pending tip
        const requestId = `tipsplit-${eventId}`
        pendingTips.set(requestId, {
            recipients,
            totalAmount
        })

        // Build breakdown
        const breakdown = recipients
            .map(r => `  • ${r.amount} ETH → <@${r.userId}>`)
            .join('\n')

        // Send confirmation dialog
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `💸 Confirm Split Tip`,
                description: `Split ${totalAmount} ETH between ${mentions.length} users (${splitAmount} each):\n\n${breakdown}`,
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

    // Parse amount
    const amount = parseAmountFromArgs(args)
    console.log('[/donate] Parsed amount:', amount, 'from args:', args)

    if (amount === null) {
        await handler.sendMessage(channelId, '❌ Please provide a valid amount.\n**Usage:** `/donate amount`')
        return
    }

    if (amount <= 0) {
        await handler.sendMessage(channelId, '❌ Amount must be greater than 0.')
        return
    }

    try {
        // Store pending donation
        const requestId = `donate-${eventId}`
        pendingTips.set(requestId, {
            recipients: [{
                userId: bot.botId,
                displayName: 'TipsoBot',
                wallet: bot.appAddress as `0x${string}`,
                amount
            }],
            totalAmount: amount
        })

        // Send confirmation dialog
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `❤️ Confirm Donation`,
                description: `Donate ${amount} ETH to support TipsoBot?\n\nYour support helps keep this bot running! 🙏`,
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

                // Send transaction request to user (native ETH transfer)
                await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}-${recipient.userId}`,
                        title: `Send ${recipient.amount} ETH`,
                        description: `Transfer ${recipient.amount} ETH on Base\n\nTo: ${recipient.wallet.slice(0, 6)}...${recipient.wallet.slice(-4)}\n\n⚠️ Make sure you have:\n• ${recipient.amount} ETH on Base\n• Extra ETH for gas (~$0.01)`,
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

            // Send success message
            if (form.requestId.startsWith('donate-')) {
                await handler.sendMessage(event.channelId, `❤️ Thank you for your ${tipData.totalAmount} ETH donation! Your support means everything! 🙏`)
            } else if (form.requestId.startsWith('tipsplit-')) {
                const recipientList = tipData.recipients
                    .map(r => `<@${r.userId}>`)
                    .join(', ')
                await handler.sendMessage(
                    event.channelId,
                    `💸 Sending ${tipData.totalAmount} ETH split between ${recipientList}!`,
                    { mentions: tipData.recipients.map(r => ({ userId: r.userId, displayName: r.displayName })) }
                )
            } else {
                const recipient = tipData.recipients[0]
                await handler.sendMessage(
                    event.channelId,
                    `💸 Sending ${tipData.totalAmount} ETH to <@${recipient.userId}>!`,
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
    const { receiverAddress, amount, currency, channelId } = event

    // Check if tip is for the bot
    if (receiverAddress.toLowerCase() === bot.appAddress.toLowerCase()) {
        const formattedAmount = formatUnits(amount, ETH_DECIMALS)

        await handler.sendMessage(
            channelId,
            `❤️ Thank you for the tip! Received ${formattedAmount} ETH! 🙏`
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
