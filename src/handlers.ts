// Interaction response handlers
import { BotHandler, BasePayload } from '@towns-protocol/bot'
import { hexToBytes, parseEther, formatEther } from 'viem'
import {
    getPendingTransaction,
    deletePendingTransaction,
    updatePendingTransaction,
    updatePendingTransactionStatus,
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
    getEthPrice: () => Promise<number>
) {
    const form = event.response.payload.content.value

    // Log event structure to understand what we have
    console.log('[Form Response] Event structure:', {
        eventId: event.eventId,
        userId: event.userId,
        spaceId: event.spaceId,
        channelId: event.channelId,
        refEventId: event.refEventId,
        responseKeys: Object.keys(event.response || {}),
        requestId: form.requestId
    })

    // Check which button was clicked
    const clickedButton = form.components.find((c: any) => c.component.case === 'button')
    console.log('[Form Response] Button clicked:', clickedButton?.id, 'Request ID:', form.requestId)

    if (!clickedButton) return

    if (clickedButton.id === 'cancel') {
        // Clean up pending transaction from database
        await deletePendingTransaction(form.requestId)
        await handler.sendMessage(event.channelId, '❌ Cancelled.')
        return
    }

    if (clickedButton.id === 'confirm') {
        try {
            // Get pending transaction from database
            const pendingTx = await getPendingTransaction(form.requestId)
            if (!pendingTx) {
                console.error('[Form Response] No pending transaction found for:', form.requestId)
                return
            }

            const data = pendingTx.data
            const ethPrice = await getEthPrice()

            // Handle different transaction types
            if (form.requestId.startsWith('contrib-')) {
                // Contribution
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.contributionUsd.toFixed(2)

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

            } else if (form.requestId.startsWith('tip-')) {
                // Regular tip
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.usdAmount.toFixed(2)

                await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Transfer ~$${usdValue} (${data.ethAmount.toFixed(6)} ETH) on Base\n\nTo: ${data.recipientWallet.slice(0, 6)}...${data.recipientWallet.slice(-4)}\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: data.recipientWallet,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))

            } else if (form.requestId.startsWith('tipsplit-')) {
                // Tip split - send multiple transactions
                for (const recipient of data.recipients) {
                    const amountWei = parseEther(recipient.ethAmount.toString())
                    const usdValue = recipient.usdAmount.toFixed(2)

                    await handler.sendInteractionRequest(event.channelId, {
                        case: 'transaction',
                        value: {
                            id: `tx-${form.requestId}-${recipient.userId}`,
                            title: `Send ~$${usdValue}`,
                            description: `Transfer ~$${usdValue} (${recipient.ethAmount.toFixed(6)} ETH) on Base\n\nTo: ${recipient.wallet.slice(0, 6)}...${recipient.wallet.slice(-4)}\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
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

            } else if (form.requestId.startsWith('donate-')) {
                // Donation
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.usdAmount.toFixed(2)

                await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Donate ~$${usdValue} (${data.ethAmount.toFixed(6)} ETH) to TipsoBot\n\nYour support is appreciated! 🙏\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: data.botAddress,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))
            }

            console.log('[Form Response] Transaction request sent')

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
    const spaceId = event.spaceId

    console.log('[Transaction Response] ========================')
    console.log('[Transaction Response] Received transaction result for:', txId)
    console.log('[Transaction Response] SpaceId:', spaceId)
    console.log('[Transaction Response] ========================')

    try {
        // Extract the original request ID from transaction ID
        // Format: tx-{type}-{eventId} or tx-{type}-{eventId}-{recipientUserId} (for tipsplit)
        const parts = txId.split('-')
        let originalRequestId: string
        let recipientUserId: string | null = null

        if (parts[0] === 'tx' && parts.length >= 3) {
            // Format: tx-tip-eventId, tx-donate-eventId, tx-contrib-eventId
            originalRequestId = `${parts[1]}-${parts[2]}`

            // For tipsplit: tx-tipsplit-eventId-recipientUserId
            if (parts.length === 4 && parts[1] === 'tipsplit') {
                recipientUserId = parts[3]
            }
        } else {
            console.error('[Transaction Response] Invalid transaction ID format:', txId)
            return
        }

        console.log('[Transaction Response] Original request ID:', originalRequestId)
        console.log('[Transaction Response] Looking up in DB...')

        // Check if transaction was already processed
        const pendingTx = await getPendingTransaction(originalRequestId)
        
        console.log('[Transaction Response] DB lookup result:', {
            found: !!pendingTx,
            status: pendingTx?.status,
            type: pendingTx?.type
        })

        if (!pendingTx) {
            console.log('[Transaction Response] 🛑 No pending transaction found (already processed or cancelled)')
            console.log('[Transaction Response] This usually means it was already deleted')
            return
        }

        if (pendingTx.status === 'processed') {
            console.log('[Transaction Response] 🛑 DUPLICATE! Transaction already marked as processed:', originalRequestId)
            console.log('[Transaction Response] Ignoring this duplicate callback')
            return
        }

        console.log('[Transaction Response] ✅ Status is "pending", proceeding with processing...')

        // Get channel and message info for updating the form
        const channelId = pendingTx.channelId
        const messageId = pendingTx.messageId

        // Handle contribution (stored in database)
        if (originalRequestId.startsWith('contrib-')) {
            console.log('[Transaction Response] Processing contribution...')
            const data = pendingTx.data
            const ethPrice = await getEthPrice()

            // Add contribution to database
            const updatedRequest = await addContribution({
                requestId: data.requestId,
                contributorId: data.contributorId,
                contributorName: 'Contributor',
                amount: data.contributionUsd
            })

            // Check if this contribution just completed the request
            const now = new Date()
            const completedAt = updatedRequest.completed_at ? new Date(updatedRequest.completed_at) : null
            const justCompleted = updatedRequest.is_completed &&
                                  completedAt &&
                                  (now.getTime() - completedAt.getTime() < 10000) // Within 10 seconds

            // Update global stats (per space/town)
            await updateGlobalStats(spaceId, {
                crowdfundingVolume: data.contributionUsd,
                crowdfundingCount: justCompleted ? 1 : 0
            })

            // Update user stats (per space/town)
            await upsertUserStats(spaceId, data.contributorId, data.contributorId, {
                sentAmount: data.contributionUsd,
                tipsSent: 1
            })
            await upsertUserStats(spaceId, data.creatorId, data.creatorName, {
                receivedAmount: data.contributionUsd,
                tipsReceived: 1
            })

            // Send success message
            await handler.sendMessage(
                data.channelId,
                `✅ <@${data.contributorId}> contributed ~$${data.contributionUsd.toFixed(2)} to <@${data.creatorId}>!`,
                { mentions: [
                    { userId: data.contributorId, displayName: data.contributorId },
                    { userId: data.creatorId, displayName: data.creatorName }
                ] }
            )

            // Get updated payment request
            const paymentRequest = await getPaymentRequest(data.requestId)
            if (paymentRequest) {
                const contributions = await getContributions(data.requestId)
                const progress = (parseFloat(paymentRequest.total_collected) / parseFloat(paymentRequest.amount)) * 100
                const progressBar = progress >= 100
                    ? '▰'.repeat(10)
                    : '▰'.repeat(Math.floor(progress / 10)) + '▱'.repeat(10 - Math.floor(progress / 10))

                // Post update message
                const updateMessage = progress >= 100
                    ? `**💰 Payment Request COMPLETED! 🎉**\n\n` +
                        `**Goal:** $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Description:** ${paymentRequest.description}\n` +
                        `**Collected:** $${parseFloat(paymentRequest.total_collected).toFixed(2)} / $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Progress:** ${progressBar} ${progress.toFixed(0)}%${progress > 100 ? ' 🚀 **Goal exceeded!**' : ''}\n` +
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

            // Mark as processed and clean up
            console.log('[Transaction Response] Marking as processed and deleting from DB')
            await updatePendingTransactionStatus(originalRequestId, 'processed')
            await deletePendingTransaction(originalRequestId)
            console.log('[Transaction Response] ✅ Contribution successfully processed!')

        } else if (originalRequestId.startsWith('tip-')) {
            // Regular tip
            console.log('[Transaction Response] Processing regular tip...')
            const data = pendingTx.data

            // Update global stats (per space/town)
            await updateGlobalStats(spaceId, {
                tipsVolume: data.usdAmount,
                tipsCount: 1
            })

            // Update user stats (per space/town)
            await upsertUserStats(spaceId, pendingTx.userId, pendingTx.userId, {
                sentAmount: data.usdAmount,
                tipsSent: 1
            })
            await upsertUserStats(spaceId, data.recipientId, data.recipientName, {
                receivedAmount: data.usdAmount,
                tipsReceived: 1
            })

            // Send success message
            await handler.sendMessage(
                data.channelId,
                `💸 <@${pendingTx.userId}> sent ~$${data.usdAmount.toFixed(2)} (${data.ethAmount.toFixed(6)} ETH) to <@${data.recipientId}>!`,
                { mentions: [
                    { userId: pendingTx.userId, displayName: pendingTx.userId },
                    { userId: data.recipientId, displayName: data.recipientName }
                ] }
            )

            // Mark as processed and clean up
            console.log('[Transaction Response] Marking as processed and deleting from DB')
            await updatePendingTransactionStatus(originalRequestId, 'processed')
            await deletePendingTransaction(originalRequestId)
            console.log('[Transaction Response] ✅ Tip successfully processed!')

        } else if (originalRequestId.startsWith('tipsplit-')) {
            // Tip split - need to wait for ALL transactions to complete
            console.log('[Transaction Response] Processing tipsplit...')
            if (!recipientUserId) {
                console.error('[Transaction Response] Missing recipient userId for tipsplit')
                return
            }

            const data = pendingTx.data

            // Add this recipient to completed list
            if (!data.completedRecipients) {
                data.completedRecipients = []
            }

            if (!data.completedRecipients.includes(recipientUserId)) {
                data.completedRecipients.push(recipientUserId)
                await updatePendingTransaction(originalRequestId, data)
            }

            console.log(`[Transaction Response] Tipsplit progress: ${data.completedRecipients.length}/${data.recipients.length}`)

            // Check if all transactions are complete
            if (data.completedRecipients.length === data.recipients.length) {
                console.log('[Transaction Response] All tipsplit transactions completed!')

                // Update global stats (per space/town)
                await updateGlobalStats(spaceId, {
                    tipsVolume: data.totalUsd,
                    tipsCount: 1
                })

                // Update user stats (per space/town)
                await upsertUserStats(spaceId, pendingTx.userId, pendingTx.userId, {
                    sentAmount: data.totalUsd,
                    tipsSent: 1
                })

                // Update each recipient's stats
                for (const recipient of data.recipients) {
                    await upsertUserStats(spaceId, recipient.userId, recipient.displayName, {
                        receivedAmount: recipient.usdAmount,
                        tipsReceived: 1
                    })
                }

                // Send success message
                const recipientList = data.recipients.map((r: any) => `<@${r.userId}>`).join(', ')
                const mentions = [
                    { userId: pendingTx.userId, displayName: pendingTx.userId },
                    ...data.recipients.map((r: any) => ({ userId: r.userId, displayName: r.displayName }))
                ]

                await handler.sendMessage(
                    data.channelId,
                    `💸 <@${pendingTx.userId}> sent ~$${data.totalUsd.toFixed(2)} (${data.totalEth.toFixed(6)} ETH) split between ${recipientList}!`,
                    { mentions }
                )

                // Mark as processed and clean up
                console.log('[Transaction Response] Marking tipsplit as processed and deleting from DB')
                await updatePendingTransactionStatus(originalRequestId, 'processed')
                await deletePendingTransaction(originalRequestId)
                console.log('[Transaction Response] ✅ Tipsplit successfully processed!')
            }

        } else if (originalRequestId.startsWith('donate-')) {
            // Donation
            console.log('[Transaction Response] Processing donation...')
            const data = pendingTx.data

            // Update global stats (per space/town)
            await updateGlobalStats(spaceId, {
                donationsVolume: data.usdAmount,
                donationsCount: 1
            })

            // Update user stats (per space/town)
            await upsertUserStats(spaceId, pendingTx.userId, pendingTx.userId, {
                sentAmount: data.usdAmount,
                donations: 1
            })

            // ✨ NEW: Send success message
            await handler.sendMessage(
                data.channelId,
                `❤️ Thank you <@${pendingTx.userId}> for your ~$${data.usdAmount.toFixed(2)} (${data.ethAmount.toFixed(6)} ETH) donation! Your support means everything! 🙏`,
                { mentions: [{ userId: pendingTx.userId, displayName: pendingTx.userId }] }
            )

            // ✨ NEW: Try to add reaction to the original confirmation message to visually "complete" it
            // This helps signal that the transaction is done
            try {
                if (messageId && messageId !== event.eventId) {
                    await handler.sendReaction(data.channelId, messageId, '✅')
                    console.log('[Transaction Response] Added reaction to confirmation message')
                }
            } catch (reactionError) {
                console.log('[Transaction Response] Could not add reaction (not critical):', reactionError)
            }

            // Mark as processed and clean up
            console.log('[Transaction Response] Marking donation as processed and deleting from DB')
            await updatePendingTransactionStatus(originalRequestId, 'processed')
            await deletePendingTransaction(originalRequestId)
            console.log('[Transaction Response] ✅ Donation successfully processed!')

        } else {
            console.log('[Transaction Response] Unknown transaction type:', originalRequestId)
        }

    } catch (error) {
        console.error('[Transaction Response] 🗑 CRITICAL ERROR:', error)
    }
}
