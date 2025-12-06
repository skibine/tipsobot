import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
import { encodeFunctionData, parseUnits, hexToBytes, erc20Abi } from 'viem'
import commands from './commands'

const pendingTips = new Map<string, { recipients: Array<{ userId: string, wallet: `0x${string}`, amount: number }>, totalAmount: number }>()

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**Available Commands:**\n\n' +
            '• `/help` - Show this help message\n' +
            '• `/time` - Get the current time\n' +
            '• `/tip @username amount` - Tip a user with USDC\n' +
            '• `/tip-split @user1 @user2 amount` - Split tip between users\n\n' +
            '**Message Triggers:**\n\n' +
            "• Mention me - I'll respond\n" +
            "• React with 👋 - I'll wave back" +
            '• Say "hello" - I\'ll greet you back\n' +
            '• Say "ping" - I\'ll show latency\n' +
            '• Say "react" - I\'ll add a reaction\n',
    )
})

bot.onSlashCommand('time', async (handler, { channelId }) => {
    const currentTime = new Date().toLocaleString()
    await handler.sendMessage(channelId, `Current time: ${currentTime} ⏰`)
})

bot.onMessage(async (handler, { message, channelId, eventId, createdAt }) => {
    if (message.includes('hello')) {
        await handler.sendMessage(channelId, 'Hello there! 👋')
        return
    }
    if (message.includes('ping')) {
        const now = new Date()
        await handler.sendMessage(channelId, `Pong! 🏓 ${now.getTime() - createdAt.getTime()}ms`)
        return
    }
    if (message.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        return
    }
})

bot.onReaction(async (handler, { reaction, channelId }) => {
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
    }
})

bot.onSlashCommand('tip', async (handler, event) => {
    const { args, mentions, channelId, userId, eventId } = event

    if (mentions.length !== 1) {
        await handler.sendMessage(channelId, 'Please mention exactly one user to tip. Usage: /tip @username amount')
        return
    }

    const recipient = mentions[0]
    const amountStr = args[0]

    if (!amountStr) {
        await handler.sendMessage(channelId, 'Please provide an amount to tip. Usage: /tip @username amount')
        return
    }

    const amount = parseFloat(amountStr)
    if (isNaN(amount) || amount <= 0) {
        await handler.sendMessage(channelId, 'Please provide a valid positive amount.')
        return
    }

    try {
        // @ts-ignore
        const recipientWallet = await getSmartAccountFromUserId(bot, { userId: recipient.userId })
        if (!recipientWallet) {
            await handler.sendMessage(channelId, 'Unable to find wallet for the mentioned user.')
            return
        }

        const requestId = `tip-${eventId}`
        pendingTips.set(requestId, {
            recipients: [{ userId: recipient.userId, wallet: recipientWallet as `0x${string}`, amount }],
            totalAmount: amount
        })

        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `Confirm Tip: ${amount} USDC to ${recipient.displayName}`,
                components: [
                    { id: 'confirm', component: { case: 'button', value: { label: 'Confirm' } } },
                    { id: 'cancel', component: { case: 'button', value: { label: 'Cancel' } } }
                ]
            }
        }, hexToBytes(userId as `0x${string}`))
    } catch (error) {
        await handler.sendMessage(channelId, 'Failed to get recipient wallet. Please try again.')
    }
})

bot.onSlashCommand('tip-split', async (handler, event) => {
    const { args, mentions, channelId, userId, eventId } = event

    if (mentions.length < 2) {
        await handler.sendMessage(channelId, 'Please mention at least two users to split the tip. Usage: /tip-split @user1 @user2 amount')
        return
    }

    const amountStr = args[args.length - 1] // Last arg is amount
    if (!amountStr) {
        await handler.sendMessage(channelId, 'Please provide an amount to tip. Usage: /tip-split @user1 @user2 amount')
        return
    }

    const totalAmount = parseFloat(amountStr)
    if (isNaN(totalAmount) || totalAmount <= 0) {
        await handler.sendMessage(channelId, 'Please provide a valid positive amount.')
        return
    }

    const splitAmount = totalAmount / mentions.length

    try {
        const recipients = []
        for (const mention of mentions) {
            // @ts-ignore
            const wallet = await getSmartAccountFromUserId(bot, { userId: mention.userId })
            if (!wallet) {
                await handler.sendMessage(channelId, `Unable to find wallet for ${mention.displayName}.`)
                return
            }
            recipients.push({ userId: mention.userId, wallet: wallet as `0x${string}`, amount: splitAmount })
        }

        const requestId = `tip-split-${eventId}`
        pendingTips.set(requestId, {
            recipients,
            totalAmount
        })

        const breakdown = recipients.map(r => `${r.amount} USDC to ${mentions.find(m => m.userId === r.userId)?.displayName}`).join('\n')
        await handler.sendInteractionRequest(channelId, {
            case: 'form',
            value: {
                id: requestId,
                title: `Confirm Split Tip: ${totalAmount} USDC`,
                components: [
                    { id: 'confirm', component: { case: 'button', value: { label: 'Confirm' } } },
                    { id: 'cancel', component: { case: 'button', value: { label: 'Cancel' } } }
                ]
            }
        }, hexToBytes(userId as `0x${string}`))
    } catch (error) {
        await handler.sendMessage(channelId, 'Failed to get recipient wallets. Please try again.')
    }
})

bot.onInteractionResponse(async (handler, event) => {
    if (event.response.payload.content?.case === 'form') {
        const form = event.response.payload.content.value
        const tipData = pendingTips.get(form.requestId)
        if (!tipData) return

        pendingTips.delete(form.requestId)

        const action = form.components.find(c => c.component.case === 'button')?.id
        if (action === 'confirm') {
            // Send transaction for each recipient
            const usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
            for (const recipient of tipData.recipients) {
                const amountWei = parseUnits(recipient.amount.toString(), 6)
                const data = encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'transfer',
                    args: [recipient.wallet as `0x${string}`, amountWei]
                })

                await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}-${recipient.userId}`,
                        title: `Send ${recipient.amount} USDC`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: usdcAddress,
                                value: '0',
                                data,
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))
            }
            await handler.sendMessage(event.channelId, `Tip request sent for ${tipData.totalAmount} USDC! 💸`)
        } else if (action === 'cancel') {
            await handler.sendMessage(event.channelId, 'Tip cancelled.')
        }
    }
})

const app = bot.start()

// Health check route
app.get('/', (c) => c.text('TipsoBot is running! 💸'))

export default app
