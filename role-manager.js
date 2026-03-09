import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

config();

// Configuration
const TOKEN = process.env.BOT_TOKEN;
const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const CHANNELS_IDS = process.env.CHANNELS_IDS.split(',')

// Role Configuration
const HIERARCH_ROLE_ID = process.env.HIERARCH_ROLE_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;

// Protected roles: Never touched by automation, always keep Hierarch
const PROTECTED_ROLES_IDS = process.env.PROTECTED_ROLES_IDS.split(',')

// Special roles: Don't compete for top 30 spots, but get Hierarch if they're top 30 caliber
const SPECIAL_ROLES_IDS = process.env.SPECIAL_ROLES_IDS.split(',')

const TOP_COUNT = 40;
const DAYS_WE_CHECK = 60;
const TWO_MONTHS_MS = 1000 * 60 * 60 * 24 * DAYS_WE_CHECK;

const LOGS_DIR = './role-logs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Starting role update process...\n`);

  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    
    console.log('Step 1: Scanning channels for mentions...');
    const mentionCount = await scanChannelsForMentions(guild);
    
    console.log('\nStep 2: Processing all members and categorizing...');
    const { regularMembers, specialMembers, protectedMembers } = await categorizeMembers(guild, mentionCount);
    
    console.log('\nStep 3: Determining who qualifies for Hierarch...');
    const qualified = determineQualified(regularMembers, specialMembers, protectedMembers);
    
    console.log('\nStep 4: Managing roles...');
    // Capture the logData returned from manageRoles (we need to modify manageRoles slightly to return this)
    const logData = await manageRoles(guild, qualified);
    
    // NEW: Send the log to Discord
    console.log('\nStep 5: Sending summary to Discord...');
    await sendSummaryToDiscord(guild, logData);
    
    console.log('\n✅ Role update completed successfully!');
    process.exit(0);

  } catch (err) {
    console.error('❌ Unexpected error:', err);
    process.exit(1);
  }
});

async function scanChannelsForMentions(guild) {
  const mentionCount = new Map();
  let totalScanned = 0;

  for (const channelId of CHANNELS_IDS) {
    console.log(`  Scanning channel: ${channelId}`);
    
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.log(`  ⚠️  Channel ${channelId} not found or not text-based, skipping...`);
      continue;
    }

    let lastMessageId = null;
    let channelScanned = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const options = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      for (const message of messages.values()) {
        channelScanned++;
        totalScanned++;

        if (Date.now() - message.createdTimestamp > TWO_MONTHS_MS) {
          console.log(`  Reached time limit. Scanned ${channelScanned} messages.`);
          break;
        }

        // --- NEW LOGIC START ---
        // Use a Set to ensure we don't double-count a user if they are mentioned 
        // in both content and embed, or mentioned multiple times in the same list.
        const uniqueUsersInMessage = new Set();

        // 1. Check Standard Content (mentions)
        for (const user of message.mentions.users.values()) {
          uniqueUsersInMessage.add(user.id);
        }

        // 2. Check Embed Descriptions (regex scan)
        if (message.embeds.length > 0) {
          for (const embed of message.embeds) {
            if (embed.description) {
              // Regex to find <@123456789> or <@!123456789>
              const matches = embed.description.matchAll(/<@!?(\d+)>/g);
              for (const match of matches) {
                // match[1] is the ID
                uniqueUsersInMessage.add(match[1]);
              }
            }
          }
        }

        // 3. Update the global count
        for (const userId of uniqueUsersInMessage) {
          mentionCount.set(userId, (mentionCount.get(userId) || 0) + 1);
        }
        // --- NEW LOGIC END ---
      }

      if (Date.now() - messages.last().createdTimestamp > TWO_MONTHS_MS) break;
      lastMessageId = messages.last().id;
    }
  }

  console.log(`  Total messages scanned: ${totalScanned}`);
  console.log(`  Unique users mentioned: ${mentionCount.size}`);
  
  return mentionCount;
}

async function categorizeMembers(guild, mentionCount) {
  const regularMembers = [];
  const specialMembers = [];
  const protectedMembers = [];

  for (const [userId, count] of mentionCount.entries()) {
    try {
      const member = await guild.members.fetch(userId);
      
      // Must have Member role
      if (!member.roles.cache.has(MEMBER_ROLE_ID)) {
        continue;
      }

      const userData = {
        userId,
        username: member.nickname || member.user.username,
        mentionCount: count,
        member
      };

      // Check for protected roles (highest priority)
      if (member.roles.cache.some(role => PROTECTED_ROLES_IDS.includes(role.id))) {
        protectedMembers.push(userData);
      }
      // Check for special roles
      else if (member.roles.cache.some(role => SPECIAL_ROLES_IDS.includes(role.id))) {
        specialMembers.push(userData);
      }
      // Regular member
      else {
        regularMembers.push(userData);
      }
    } catch (err) {
      console.log(`  ⚠️  Could not fetch user ${userId}`);
    }
  }

  // Sort all by mention count (descending)
  regularMembers.sort((a, b) => b.mentionCount - a.mentionCount);
  specialMembers.sort((a, b) => b.mentionCount - a.mentionCount);

  console.log(`  Regular members: ${regularMembers.length}`);
  console.log(`  Special role members: ${specialMembers.length}`);
  console.log(`  Protected members: ${protectedMembers.length}`);

  return { regularMembers, specialMembers, protectedMembers };
}

function determineQualified(regularMembers, specialMembers, protectedMembers) {
  // Top regular members always qualify
  const topRegular = regularMembers.slice(0, TOP_COUNT);
  
  // Get the threshold: mentions needed to be in the top list
  const threshold = topRegular.length > 0 
    ? topRegular[topRegular.length - 1].mentionCount 
    : 0;

  console.log(`  Top ${TOP_COUNT} threshold: ${threshold} mentions`);

  // Special members qualify if they beat the threshold (not tie)
  const qualifiedSpecial = specialMembers.filter(m => m.mentionCount > threshold);

  // Protected members always qualify (they were mentioned)
  const qualifiedProtected = protectedMembers;

  console.log(`  Qualified regular members: ${topRegular.length}`);
  console.log(`  Qualified special members: ${qualifiedSpecial.length}`);
  console.log(`  Protected members: ${qualifiedProtected.length}`);
  console.log(`  Total qualified for Hierarch: ${topRegular.length + qualifiedSpecial.length + qualifiedProtected.length}`);

  return {
    topRegular,
    qualifiedSpecial,
    qualifiedProtected,
    threshold
  };
}

async function manageRoles(guild, qualified) {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    top40: [],
    specialRoles: [],
    protected: [],
    rolesAdded: [],
    rolesRemoved: []
  };

  // Build set of all qualified user IDs
  const qualifiedUserIds = new Set();
  qualified.topRegular.forEach(u => qualifiedUserIds.add(u.userId));
  qualified.qualifiedSpecial.forEach(u => qualifiedUserIds.add(u.userId));
  qualified.qualifiedProtected.forEach(u => qualifiedUserIds.add(u.userId));

  // Log top regular members
  console.log(`\n  📊 Top ${TOP_COUNT} Regular Members:`);
  for (let i = 0; i < qualified.topRegular.length; i++) {
    const user = qualified.topRegular[i];
    console.log(`    ${i + 1}. ${user.username} - ${user.mentionCount} mentions`);
    logData.top40.push({
      rank: i + 1,
      username: user.username,
      userId: user.userId,
      mentions: user.mentionCount
    });
  }
  // Log qualified special roles
  if (qualified.qualifiedSpecial.length > 0) {
    console.log('\n  ⭐ Qualified Special Role Members (beat threshold):');
    qualified.qualifiedSpecial.forEach(user => {
      console.log(`    • ${user.username} - ${user.mentionCount} mentions`);
      logData.specialRoles.push({
        username: user.username,
        userId: user.userId,
        mentions: user.mentionCount
      });
    });
  }
  // Log protected members
  if (qualified.qualifiedProtected.length > 0) {
    console.log('\n  🛡️  Protected Members (always keep):');
    qualified.qualifiedProtected.forEach(user => {
      console.log(`    • ${user.username} - ${user.mentionCount} mentions`);
      logData.protected.push({
        username: user.username,
        userId: user.userId,
        mentions: user.mentionCount
      });
    });
  }
  // Fetch Hierarch role
  const hierarchRole = await guild.roles.fetch(HIERARCH_ROLE_ID);
  if (!hierarchRole) {
    console.error('  ❌ Hierarch role not found!');
    return;
  }
  console.log('\n  🔄 Role Changes:');

  // Add role to all qualified members
  const allQualified = [
    ...qualified.topRegular,
    ...qualified.qualifiedSpecial,
    ...qualified.qualifiedProtected
  ];
  for (const user of allQualified) {
    if (!user.member.roles.cache.has(HIERARCH_ROLE_ID)) {
      await user.member.roles.add(HIERARCH_ROLE_ID);
      console.log(`    ✅ Added role to: ${user.username}`);
      logData.rolesAdded.push({
        username: user.username,
        userId: user.userId,
        mentions: user.mentionCount
      });
    }
  }
  // Handle users who have the role but don't qualify
  for (const [memberId] of hierarchRole.members) {
    if (!qualifiedUserIds.has(memberId)) {
      try {
        const member = await guild.members.fetch(memberId);
        const username = member.nickname || member.user.username;
        // Check if user has protected roles - never remove
        const hasProtectedRole = member.roles.cache.some(role => 
          PROTECTED_ROLES_IDS.includes(role.id)
        );
        if (hasProtectedRole) {
          console.log(`    🛡️  Skipping protected user: ${username}`);
          continue;
        }

        await member.roles.remove(HIERARCH_ROLE_ID);
        console.log(`    ❌ Removed role from: ${username}`);
        logData.rolesRemoved.push({
          username,
          userId: memberId,
          reason: 'Not qualified'
        });
      } catch (err) {
        console.log(`  ⚠️  Could not fetch member ${memberId}: ${err.message}`);
      }
    }
  }

  // Save detailed log
  const logFileName = `role-update-${new Date().toISOString().split('T')[0]}.json`;
  const logPath = path.join(LOGS_DIR, logFileName);
  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf8');
  // Create human-readable summary
  const summaryLines = [
    `Role Update Summary - ${new Date().toLocaleString()}`,
    `${'='.repeat(60)}`,
    '',
    `📊 TOP ${TOP_COUNT} REGULAR MEMBERS:`,
    ...logData.top40.map(u => `  ${u.rank}. ${u.username} - ${u.mentions} mentions`),
    ''
  ];
  if (logData.specialRoles.length > 0) {
    summaryLines.push(
      `⭐ QUALIFIED SPECIAL ROLE MEMBERS (${logData.specialRoles.length}):`,
      ...logData.specialRoles.map(u => `  • ${u.username} - ${u.mentions} mentions`),
      ''
    );
  }
  if (logData.protected.length > 0) {
    summaryLines.push(
      `🛡️  PROTECTED MEMBERS (${logData.protected.length}):`,
      ...logData.protected.map(u => `  • ${u.username} - ${u.mentions} mentions`),
      ''
    );
  }
  summaryLines.push(
    `✅ ROLES ADDED (${logData.rolesAdded.length}):`,
    ...(logData.rolesAdded.length > 0 
      ? logData.rolesAdded.map(u => `  + ${u.username} (${u.mentions} mentions)`)
      : ['  None']),
    '',
    `❌ ROLES REMOVED (${logData.rolesRemoved.length}):`,
    ...(logData.rolesRemoved.length > 0
      ? logData.rolesRemoved.map(u => `  - ${u.username} (${u.reason})`)
      : ['  None']),
    ''
  );
  summaryLines.push(
    `📈 TOTAL WITH HIERARCH: ${logData.top40.length + logData.specialRoles.length + logData.protected.length}`
  );
  const summaryPath = path.join(LOGS_DIR, 'latest-summary.txt');
  fs.writeFileSync(summaryPath, summaryLines.join('\n'), 'utf8');
  const historySummaryFileName = `summary-${new Date().toISOString().split('T')[0]}.txt`;
  const historySummaryPath = path.join(LOGS_DIR, historySummaryFileName);
  fs.writeFileSync(historySummaryPath, summaryLines.join('\n'), 'utf8');

  console.log(`\n  📝 Logs saved to: ${LOGS_DIR}`);
  console.log(`     - Detailed JSON: ${logFileName}`);
  console.log(`     - Latest Summary: latest-summary.txt`);
  console.log(`     - History Summary: ${historySummaryFileName}`);
  // ADD THIS at the very end of the function
  return logData;
}

async function sendSummaryToDiscord(guild, logData) {
  try {
    const channel = await guild.channels.fetch(SUMMARY_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error('  ⚠️  Summary channel not found or not text-based.');
      return;
    }

    // Helper to format a list of users
    const formatList = (users) => {
      if (!users || users.length === 0) return null;
      return users.map(u => `- <@${u.userId}>`).join('\n');
    };

    let rosterMsg = `# Summary of Attendance\nBased on people who signed up in Yeek threads last ${DAYS_WE_CHECK} days\n`;    
    
    // 1. Construct the "Current Roster" message
    rosterMsg += `## Top ${TOP_COUNT} Members\n${formatList(logData.top40)}\n`;
    
    if (logData.specialRoles.length > 0 || logData.protected.length > 0) {
      rosterMsg += `## Qualified Special & Protected Roles\n${formatList(
        (logData.protected||[]).concat((logData.specialRoles||[]))
      )}\n`;
    }
    
    // 2. Construct the "Changes" message
    let changesMsg = `# Hierarch Role Changes Update\n`;
    let hasChanges = false;
    
    if (logData.rolesAdded.length > 0) {
      changesMsg += `## Role Added\n${formatList(logData.rolesAdded)}\n`;
      hasChanges = true;
    }

    if (logData.rolesRemoved.length > 0) {
      // For removed, we show the reason too, or just the tag if you prefer
      changesMsg += `## Role Removed\n${logData.rolesRemoved.map(u => `- <@${u.userId}> (${u.reason})`).join('\n')}\n`;
      hasChanges = true;
    }
    
    if (!hasChanges) {
      changesMsg += `- No role changes this week.`;
    }
    // Send messages (splitting if they are too long)
    // Discord limit is 2000 chars. We use a simple split strategy here.
    
    // const sendSafe = async (content) => {
    //   if (content.length < 2000) {
    //     await channel.send(content);
    //   } else {
    //     // Simple chunking by newline if message is huge
    //     const chunks = content.match(/[\s\S]{1,1900}(?=\n|$)/g) || [];
    //     for (const chunk of chunks) {
    //       await channel.send(chunk);
    //     }
    //   }
    // };

    const embed = new EmbedBuilder()
      .setColor(0xFEFE92)
      .setDescription(
        `${rosterMsg + changesMsg}`
      )

    await channel.send({
      embeds: [embed],
    });

    // await sendSafe(rosterMsg);
    // await sendSafe(changesMsg);

    console.log('  ✅ Discord summary sent.');

  } catch (err) {
    console.error('  ❌ Failed to send Discord summary:', err);
  }
}

client.login(TOKEN).catch(err => {
  console.error('Login failed:', err.message || err);
});