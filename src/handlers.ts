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

// Handle form responses (button clicks on Confirm/Cancel)
export async function handleFormResponse(
    handler: BotHandler,
    event: any,
    getEthPrice: () => Promise<number>
) {
    const form = event.response.payload.content.value

    console.log('[Form Response] ========================')
    console.log('[Form Response] Request ID:', form.requestId)
    console.log('[Form Response] Event structure:', {
        eventId: event.eventId,
        userId: event.userId,
        channelId: event.channelId
    })

    // Get pending transaction from database
    const pendingTx = await getPendingTransaction(form.requestId)
    
    if (!pendingTx) {
        console.error('[Form Response] No pending transaction found for:', form.requestId)
        return
    }

    console.log('[Form Response] Found pending transaction:', {
        type: pendingTx.type,
        status: pendingTx.status,
        messageId: pendingTx.messageId
    })

    // 🔑 KEY FIX: Delete the form IMMEDIATELY after any button click
    // This prevents users from re-clicking cached buttons after page refresh
    if (pendingTx.messageId) {
        try {
            console.log('[Form Response] 🗑️ Attempting to delete form with removeEvent, messageId:', pendingTx.messageId)
            await handler.removeEvent(event.channelId, pendingTx.messageId)
            console.log('[Form Response] ✅ Form deleted with removeEvent')
        } catch (error) {
            console.error('[Form Response] ❌ removeEvent failed:', error)
            // Try adminRemoveEvent as fallback
            try {
                console.log('[Form Response] 🗑️ Attempting adminRemoveEvent as fallback...')
                await handler.adminRemoveEvent(event.channelId, pendingTx.messageId)
                console.log('[Form Response] ✅ Form deleted with adminRemoveEvent')
            } catch (adminError) {
                console.error('[Form Response] ❌ adminRemoveEvent also failed:', adminError)
            }
        }
    } else {
        console.log('[Form Response] ⚠️ No messageId found, cannot delete form')
    }

    // Find which button was clicked
    const clickedButton = form.components.find((c: any) => c.component.case === 'button')
    console.log('[Form Response] Button clicked:', clickedButton?.id)

    if (!clickedButton) {
        console.error('[Form Response] No button found in form components')
        return
    }

    // Handle Cancel button
    if (clickedButton.id === 'cancel') {
        await deletePendingTransaction(form.requestId)
        await handler.sendMessage(event.channelId, '❌ Cancelled.')
        console.log('[Form Response] Transaction cancelled by user')
        return
    }

    // Handle Confirm button
    if (clickedButton.id === 'confirm') {
        try {
            const data = pendingTx.data
            const ethPrice = await getEthPrice()

            // Handle different transaction types
            if (form.requestId.startsWith('contrib-')) {
                // Contribution
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.contributionUsd.toFixed(2)

                const txMessage = await handler.sendInteractionRequest(event.channelId, {
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

                // Save transaction form messageId for later deletion
                const txMessageId = txMessage?.id || event.eventId
                data.transactionMessageId = txMessageId
                await updatePendingTransaction(form.requestId, data)
                console.log('[Form Response] Transaction form sent, messageId:', txMessageId)

            } else if (form.requestId.startsWith('tip-')) {
                // Regular tip
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.usdAmount.toFixed(2)

                const txMessage = await handler.sendInteractionRequest(event.channelId, {
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

                // Save transaction form messageId for later deletion
                const txMessageId = txMessage?.id || event.eventId
                data.transactionMessageId = txMessageId
                await updatePendingTransaction(form.requestId, data)
                console.log('[Form Response] Transaction form sent, messageId:', txMessageId)

            } else if (form.requestId.startsWith('tipsplit-')) {
                // Tip split - send multiple transactions and save their messageIds
                const transactionMessageIds: string[] = []

                for (const recipient of data.recipients) {
                    const amountWei = parseEther(recipient.ethAmount.toString())
                    const usdValue = recipient.usdAmount.toFixed(2)

                    const txMessage = await handler.sendInteractionRequest(event.channelId, {
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

                    // Save each transaction message ID
                    const txMessageId = txMessage?.id || `${event.eventId}-${recipient.userId}`
                    transactionMessageIds.push(txMessageId)
                }

                // Save all transaction form messageIds for later deletion
                data.transactionMessageIds = transactionMessageIds
                await updatePendingTransaction(form.requestId, data)
                console.log('[Form Response] Tipsplit transaction forms sent, messageIds:', transactionMessageIds)

            } else if (form.requestId.startsWith('donate-')) {
                // Donation
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.usdAmount.toFixed(2)

                const txMessage = await handler.sendInteractionRequest(event.channelId, {
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

                // Save transaction form messageId for later deletion
                const txMessageId = txMessage?.id || event.eventId
                data.transactionMessageId = txMessageId
                await updatePendingTransaction(form.requestId, data)
                console.log('[Form Response] Transaction form sent, messageId:', txMessageId)
            }

            console.log('[Form Response] Transaction request sent successfully')

        } catch (error) {
            console.error('[Form Response] Error processing confirmation:', error)
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
            console.log('[Transaction Response] 🛑 No transaction record found at all')
            return
        }

        // 🔑 KEY FIX: Check if already processed (not just pending)
        if (pendingTx.status === 'processed') {
            console.log('[Transaction Response] 🛑 DUPLICATE! Transaction already processed:', originalRequestId)
            console.log('[Transaction Response] Ignoring this duplicate callback')
            return
        }

        if (pendingTx.status === 'pending') {
            console.log('[Transaction Response] ✅ Status is "pending", proceeding with processing...')
        } else {
            console.log('[Transaction Response] Status is:', pendingTx.status)
            return
        }

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

            // Delete transaction form if messageId exists
            if (data.transactionMessageId) {
                try {
                    console.log('[Transaction Response] 🗑️ Attempting to delete transaction form, messageId:', data.transactionMessageId)
                    await handler.removeEvent(data.channelId, data.transactionMessageId)
                    console.log('[Transaction Response] ✅ Transaction form deleted with removeEvent')
                } catch (error) {
                    console.error('[Transaction Response] ❌ removeEvent failed:', error)
                    // Try adminRemoveEvent as fallback
                    try {
                        console.log('[Transaction Response] 🗑️ Attempting adminRemoveEvent as fallback...')
                        await handler.adminRemoveEvent(data.channelId, data.transactionMessageId)
                        console.log('[Transaction Response] ✅ Transaction form deleted with adminRemoveEvent')
                    } catch (adminError) {
                        console.error('[Transaction Response] ❌ adminRemoveEvent also failed:', adminError)
                    }
                }
            }

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

            // 🔑 KEY FIX: Mark as processed but DON'T delete (keep for 7 days for duplicate detection)
            console.log('[Transaction Response] Marking as processed (keeping in DB for 7 days)')
            await updatePendingTransactionStatus(originalRequestId, 'processed')
            
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

            // Delete transaction form if messageId exists
            if (data.transactionMessageId) {
                try {
                    console.log('[Transaction Response] 🗑️ Attempting to delete transaction form, messageId:', data.transactionMessageId)
                    await handler.removeEvent(data.channelId, data.transactionMessageId)
                    console.log('[Transaction Response] ✅ Transaction form deleted with removeEvent')
                } catch (error) {
                    console.error('[Transaction Response] ❌ removeEvent failed:', error)
                    // Try adminRemoveEvent as fallback
                    try {
                        console.log('[Transaction Response] 🗑️ Attempting adminRemoveEvent as fallback...')
                        await handler.adminRemoveEvent(data.channelId, data.transactionMessageId)
                        console.log('[Transaction Response] ✅ Transaction form deleted with adminRemoveEvent')
                    } catch (adminError) {
                        console.error('[Transaction Response] ❌ adminRemoveEvent also failed:', adminError)
                    }
                }
            }

            // Send success message
            await handler.sendMessage(
                data.channelId,
                `💸 <@${pendingTx.userId}> sent ~$${data.usdAmount.toFixed(2)} (${data.ethAmount.toFixed(6)} ETH) to <@${data.recipientId}>!`,
                { mentions: [
                    { userId: pendingTx.userId, displayName: pendingTx.userId },
                    { userId: data.recipientId, displayName: data.recipientName }
                ] }
            )

            // 🔑 KEY FIX: Mark as processed but DON'T delete
            console.log('[Transaction Response] Marking as processed (keeping in DB for 7 days)')
            await updatePendingTransactionStatus(originalRequestId, 'processed')
            
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

                // Delete all transaction forms if messageIds exist
                if (data.transactionMessageIds && data.transactionMessageIds.length > 0) {
                    for (const txMessageId of data.transactionMessageIds) {
                        try {
                            console.log('[Transaction Response] 🗑️ Attempting to delete tipsplit transaction form, messageId:', txMessageId)
                            await handler.removeEvent(data.channelId, txMessageId)
                            console.log('[Transaction Response] ✅ Tipsplit transaction form deleted with removeEvent')
                        } catch (error) {
                            console.error('[Transaction Response] ❌ removeEvent failed:', error)
                            // Try adminRemoveEvent as fallback
                            try {
                                console.log('[Transaction Response] 🗑️ Attempting adminRemoveEvent as fallback...')
                                await handler.adminRemoveEvent(data.channelId, txMessageId)
                                console.log('[Transaction Response] ✅ Tipsplit transaction form deleted with adminRemoveEvent')
                            } catch (adminError) {
                                console.error('[Transaction Response] ❌ adminRemoveEvent also failed:', adminError)
                            }
                        }
                    }
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

                // 🔑 KEY FIX: Mark as processed but DON'T delete
                console.log('[Transaction Response] Marking tipsplit as processed (keeping in DB for 7 days)')
                await updatePendingTransactionStatus(originalRequestId, 'processed')
                
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

            // Delete transaction form if messageId exists
            if (data.transactionMessageId) {
                try {
                    console.log('[Transaction Response] 🗑️ Attempting to delete transaction form, messageId:', data.transactionMessageId)
                    await handler.removeEvent(data.channelId, data.transactionMessageId)
                    console.log('[Transaction Response] ✅ Transaction form deleted with removeEvent')
                } catch (error) {
                    console.error('[Transaction Response] ❌ removeEvent failed:', error)
                    // Try adminRemoveEvent as fallback
                    try {
                        console.log('[Transaction Response] 🗑️ Attempting adminRemoveEvent as fallback...')
                        await handler.adminRemoveEvent(data.channelId, data.transactionMessageId)
                        console.log('[Transaction Response] ✅ Transaction form deleted with adminRemoveEvent')
                    } catch (adminError) {
                        console.error('[Transaction Response] ❌ adminRemoveEvent also failed:', adminError)
                    }
                }
            }

            // Send success message
            await handler.sendMessage(
                data.channelId,
                `❤️ Thank you <@${pendingTx.userId}> for your ~$${data.usdAmount.toFixed(2)} (${data.ethAmount.toFixed(6)} ETH) donation! Your support means everything! 🙏`,
                { mentions: [{ userId: pendingTx.userId, displayName: pendingTx.userId }] }
            )

            // 🔑 KEY FIX: Mark as processed but DON'T delete (keep for 7 days)
            console.log('[Transaction Response] Marking donation as processed (keeping in DB for 7 days)')
            await updatePendingTransactionStatus(originalRequestId, 'processed')
            
            console.log('[Transaction Response] ✅ Donation successfully processed!')

        } else {
            console.log('[Transaction Response] Unknown transaction type:', originalRequestId)
        }

    } catch (error) {
        console.error('[Transaction Response] 🔥 CRITICAL ERROR:', error)
    }
}
