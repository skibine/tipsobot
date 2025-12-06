import type { BotCommand } from '@towns-protocol/bot'

// Those commands will be registered to the bot as soon as the bot is initialized
// and will be available in the slash command autocomplete.
const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'time',
        description: 'Get the current time',
    },
    {
        name: 'tip',
        description: 'Tip a user with USDC',
    },
    {
        name: 'tip-split',
        description: 'Split tip between multiple users',
    },
    {
        name: 'donate',
        description: 'Donate USDC to support the bot',
    },
] as const satisfies BotCommand[]

export default commands
