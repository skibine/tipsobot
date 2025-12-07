// Interaction response handlers
import { BotHandler, BasePayload } from '@towns-protocol/bot'
import { hexToBytes, parseEther, formatEther } from 'viem'
import {
    getPendingTransaction,
    deletePendingTransaction,
    updateGlobalStats,
    upsertUserStats,
    addContribution,
    getPaymentRequest,
    getContributions
} from './db'

// Handle form responses (button clicks)
export async function handleFormResponse(
    handler: BotHandler,
    event: any,
    pendingTips: Map<string, any>,
    getEthPrice: () => Promise<number>
) {
    const form = event.response.payload.content.value

    // Check which button was clicked
    const clickedButton = form.components.find((c: any) => c.component.case === 'button')
    console.log('[Form Response] Button clicked:', clickedButton?.id, 'Request ID:', form.requestId)

    if (!clickedButton) return

    if (clickedButton.id === 'cancel') {
        // Clean up pending transaction if it's a contribute
        if (form.requestId.startsWith('contrib-')) {
            await deletePendingTransaction(form.requestId)
        }
        await handler.sendMessage(event.channelId, '❌ Cancelled.')
        return
    }

    if (clickedButton.id === 'confirm') {
        try {
            // Handle contribute (from database)
            if (form.requestId.startsWith('contrib-')) {
                const pendingTx = await getPendingTransaction(form.requestId)
                if (!pendingTx) {
                    console.error('[Form Response] No pending transaction found for:', form.requestId)
                    return
                }

                const data = pendingTx.data
                const amountWei = parseEther(data.ethAmount.toString())
                const ethPrice = await getEthPrice()
                const usdValue = data.contributionUsd.toFixed(2)

                // Send transaction request
                await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Transfer ~$${usdValue} (${data.ethAmount.toFixed(6)} ETH) on Base\n\nTo: ${data.creatorWallet.slice(0, 6)}...${data.creatorWallet.slice(-4)}\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: data.creatorWallet,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))

                console.log('[Form Response] Transaction request sent for contribution')
                return
            }

            // Handle other types (tip, tipsplit, donate) - use old Map-based system for now
            const tipData = pendingTips.get(form.requestId)
            if (!tipData) {
                console.error('[Form Response] No pending tip data found for:', form.requestId)
                return
            }

            // Clean up stored data
            pendingTips.delete(form.requestId)

            // Send transaction request for each recipient
            for (const recipient of tipData.recipients) {
                const amountWei = parseEther(recipient.amount.toString())
                const ethPrice = await getEthPrice()
                const usdValue = (recipient.amount * ethPrice).toFixed(2)

                await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}-${recipient.userId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Transfer ~$${usdValue} (${recipient.amount.toFixed(6)} ETH) on Base\n\nTo: ${recipient.wallet.slice(0, 6)}...${recipient.wallet.slice(-4)}\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: recipient.wallet,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))
            }

            console.log('[Form Response] Transaction requests sent')

        } catch (error) {
            console.error('[Form Response] Error:', error)
            await handler.sendMessage(event.channelId, '❌ Failed to send transaction request. Please try again.')
        }
    }
}

// Handle transaction responses (actual blockchain transactions)
export async function handleTransactionResponse(
    handler: BotHandler,
    event: any,
    getEthPrice: () => Promise<number>
) {
    const transaction = event.response.payload.content.value
    const txId = transaction.requestId

    console.log('[Transaction Response] Received for:', txId)

    try {
        // Extract the original request ID from transaction ID
        // Format: tx-{originalRequestId}-{recipientUserId} or tx-{originalRequestId}
        const parts = txId.split('-')
        let originalRequestId: string

        if (parts[0] === 'tx' && parts.length >= 3) {
            // Format: tx-contrib-eventId or tx-donate-eventId or tx-tip-eventId
            originalRequestId = `${parts[1]}-${parts[2]}`
        } else {
            console.error('[Transaction Response] Invalid transaction ID format:', txId)
            return
        }

        console.log('[Transaction Response] Original request ID:', originalRequestId)

        // Handle contribution (stored in database)
        if (originalRequestId.startsWith('contrib-')) {
            const pendingTx = await getPendingTransaction(originalRequestId)
            if (!pendingTx) {
                console.log('[Transaction Response] No pending contribution found (already processed or cancelled)')
                return
            }

            const data = pendingTx.data
            const ethPrice = await getEthPrice()

            // Add contribution to database
            const updatedRequest = await addContribution({
                requestId: data.requestId,
                contributorId: data.contributorId,
                contributorName: 'Contributor',
                amount: data.contributionUsd
            })

            // Update global stats
            await updateGlobalStats({
                crowdfundingVolume: data.contributionUsd,
                crowdfundingCount: updatedRequest.is_completed && !updatedRequest.completed_at ? 1 : 0
            })

            // Update user stats
            await upsertUserStats(data.contributorId, 'Contributor', {
                sentAmount: data.contributionUsd,
                tipsSent: 1
            })
            await upsertUserStats(data.creatorId, data.creatorName, {
                receivedAmount: data.contributionUsd,
                tipsReceived: 1
            })

            // Send success message
            await handler.sendMessage(
                data.channelId,
                `✅ Contribution confirmed! ~$${data.contributionUsd.toFixed(2)} sent to <@${data.creatorId}>`,
                { mentions: [{ userId: data.creatorId, displayName: data.creatorName }] }
            )

            // Get updated payment request
            const paymentRequest = await getPaymentRequest(data.requestId)
            if (paymentRequest) {
                const contributions = await getContributions(data.requestId)
                const progress = Math.min(100, (parseFloat(paymentRequest.total_collected) / parseFloat(paymentRequest.amount)) * 100)
                const progressBar = '▰'.repeat(Math.floor(progress / 10)) + '▱'.repeat(10 - Math.floor(progress / 10))

                // Post update message
                const updateMessage = progress >= 100
                    ? `**💰 Payment Request COMPLETED! 🎉**\n\n` +
                        `**Goal:** $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Description:** ${paymentRequest.description}\n` +
                        `**Collected:** $${parseFloat(paymentRequest.total_collected).toFixed(2)} / $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Progress:** ${progressBar} ${progress.toFixed(0)}%\n` +
                        `**Contributors:** ${contributions.length}\n\n` +
                        `🎉 **Goal reached! Thank you to all contributors!** 🎉`
                    : `**💰 Payment Request Updated**\n\n` +
                        `**Goal:** $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Description:** ${paymentRequest.description}\n` +
                        `**Collected:** $${parseFloat(paymentRequest.total_collected).toFixed(2)} / $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Progress:** ${progressBar} ${progress.toFixed(0)}%\n` +
                        `**Contributors:** ${contributions.length}\n\n` +
                        `To contribute: \`/contribute ${data.requestId} amount\``

                await handler.sendMessage(paymentRequest.channel_id, updateMessage)
            }

            // Clean up pending transaction
            await deletePendingTransaction(originalRequestId)

        } else {
            // Handle other transaction types (tip, tipsplit, donate)
            // These are handled immediately after confirmation for now
            // TODO: Migrate to database-backed pending transactions
            console.log('[Transaction Response] Non-contribution transaction:', originalRequestId)
        }

    } catch (error) {
        console.error('[Transaction Response] Error:', error)
    }
}
