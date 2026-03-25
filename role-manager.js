import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

config();

// Configuration
const TOKEN = process.env.BOT_TOKEN;
const YEEK_BOT_ID = process.env.YEEK_BOT_ID;
const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const CHANNELS_IDS = process.env.CHANNELS_IDS.split(',');

// Role Configuration
const HIERARCH_ROLE_ID = process.env.HIERARCH_ROLE_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;

// Protected roles: Never touched by automation, always keep Hierarch
const PROTECTED_ROLES_IDS = process.env.PROTECTED_ROLES_IDS.split(',');

// Special roles: Don't compete for top 30 spots, but get Hierarch if they're top 30 caliber
const SPECIAL_ROLES_IDS = process.env.SPECIAL_ROLES_IDS.split(',');

const TOP_COUNT = 40;
const DAYS_WE_CHECK = 60;
const TWO_MONTHS_MS = 1000 * 60 * 60 * 24 * DAYS_WE_CHECK;

const WEEKLY_TOP_3_ROLE_ID = '1485778453394489415';
const WEEKLY_TOP_10_ROLE_ID = '1485778538459173024';
const WEEKLY_TOP_25_ROLE_ID = '1485778597397528747';
const WEEKLY_TOP_50_ROLE_ID = '1486349087170363492';

const SEVEN_DAYS_MS = 1000 * 60 * 60 * 24 * 7;
        
const LOGS_DIR = './role-logs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// MERGED Execution Block
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Starting execution sequence...\n`);

  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const guild = await client.guilds.fetch(GUILD_ID); 
  const args = process.argv.slice(2);
  const isDaily = args.includes('--daily');
  const isWeekly = args.includes('--weekly');

  try {
    if (isDaily) {
      console.log('\n--- Executing Daily 7-Day Run ---');
      const { weeklyMentionCount } = await scanChannelsForMentions(guild, false);
      await manageWeeklyRoles(guild, weeklyMentionCount);
      console.log('\n✅ Daily role update completed successfully!');
      
    } else if (isWeekly) {
      console.log('\n--- Executing Weekly 60-Day Hierarch Run ---');
      const { mentionCount } = await scanChannelsForMentions(guild, true);
      const { regularMembers, specialMembers, protectedMembers } = await categorizeMembers(guild, mentionCount);
      const qualified = determineQualified(regularMembers, specialMembers, protectedMembers);
      const logData = await manageRoles(guild, qualified);
      
      console.log('\nStep 5: Sending summary to Discord...');
      await sendSummaryToDiscord(guild, logData);
      console.log('\n✅ Weekly role update completed successfully!');
      
    } else {
      console.log('Error: No valid flag provided. Run with --daily or --weekly');
    }
  } catch (error) {
    console.error('❌ An error occurred during execution:', error);
  }

  // CRITICAL: Shut down the bot so the Linux cron job actually finishes
  console.log('\nExecution complete. Shutting down process...');
  process.exit(0); 
});

async function scanChannelsForMentions(guild, scanFullHistory = true) {
  const mentionCount = new Map();
  const weeklyMentionCount = new Map();
  let totalScanned = 0;

  const maxScanLimitMs = scanFullHistory ? TWO_MONTHS_MS : SEVEN_DAYS_MS;

  for (const channelId of CHANNELS_IDS) {
    console.log(`  Scanning channel: ${channelId}`);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) continue;

    let lastMessageId = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const options = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      for (const message of messages.values()) {
        totalScanned++;
        
        // Skip messages not sent by Yeek
        if (message.author.id !== YEEK_BOT_ID) continue;

        const ageMs = Date.now() - message.createdTimestamp;

        if (ageMs > maxScanLimitMs) {
          break; // Stop scanning further back in this channel
        }

        const isWeekly = ageMs <= SEVEN_DAYS_MS;
        const uniqueUsersInMessage = new Set();

        for (const user of message.mentions.users.values()) {
          uniqueUsersInMessage.add(user.id);
        }

        if (message.embeds.length > 0) {
          for (const embed of message.embeds) {
            if (embed.description) {
              const matches = embed.description.matchAll(/<@!?(\d+)>/g);
              for (const match of matches) uniqueUsersInMessage.add(match[1]);
            }
          }
        }

        for (const userId of uniqueUsersInMessage) {
          if (scanFullHistory) {
            mentionCount.set(userId, (mentionCount.get(userId) || 0) + 1);
          }
          if (isWeekly) {
            weeklyMentionCount.set(userId, (weeklyMentionCount.get(userId) || 0) + 1);
          }
        }
      }

      if (Date.now() - messages.last().createdTimestamp > maxScanLimitMs) break;
      lastMessageId = messages.last().id;
    }
  }
  console.log(`  Total messages scanned: ${totalScanned}`);
  console.log(`  Unique users mentioned: ${mentionCount.size}`);
  

  return { mentionCount, weeklyMentionCount };
}

async function manageWeeklyRoles(guild, weeklyMentionCount) {
  const weeklyActive = [];

  // Filter down to valid guild members
  for (const [userId, count] of weeklyMentionCount.entries()) {
    try {
      const member = await guild.members.fetch(userId);
      if (member.roles.cache.has(MEMBER_ROLE_ID)) {
        weeklyActive.push({ userId, count, member });
      }
    } catch (err) {
      // User left the server
    }
  }

  // Sort highest to lowest mentions
  weeklyActive.sort((a, b) => b.count - a.count);
  const totalActive = weeklyActive.length;

  if (totalActive === 0) {
    console.log('  No weekly activity found.');
    return;
  }

  // Hard caps for the top players
  const cut3 = 3;
  const cut10 = 10;
  const cut25 = 25;
  const cut50 = 50;

  // Start from index 0 for all tiers so roles stack downward
  const top3Ids = new Set(weeklyActive.slice(0, cut3).map(m => m.userId));
  const top10Ids = new Set(weeklyActive.slice(0, cut10).map(m => m.userId));
  const top25Ids = new Set(weeklyActive.slice(0, cut25).map(m => m.userId));
  const top50Ids = new Set(weeklyActive.slice(0, cut50).map(m => m.userId));

  console.log(`  Weekly Active: ${totalActive} | Top 3: ${top3Ids.size} | Top 10: ${top10Ids.size} | Top 25: ${top25Ids.size}`);

  const roleDefinitions = [
    { id: WEEKLY_TOP_3_ROLE_ID, validSet: top3Ids, name: 'Top 3' },
    { id: WEEKLY_TOP_10_ROLE_ID, validSet: top10Ids, name: 'Top 10' },
    { id: WEEKLY_TOP_25_ROLE_ID, validSet: top25Ids, name: 'Top 25' },
    { id: WEEKLY_TOP_50_ROLE_ID, validSet: top50Ids, name: 'Top 50' }
  ];

  // Apply & Remove Roles
  for (const def of roleDefinitions) {
    if (!def.id) continue; 

    const role = await guild.roles.fetch(def.id);
    if (!role) continue;

    // Strip role from players who dropped out of the bracket
    for (const [memberId, member] of role.members) {
      if (!def.validSet.has(memberId)) {
        await member.roles.remove(def.id);
        console.log(`    ❌ Removed ${def.name} from: ${member.nickname || member.user.username}`);
      }
    }

    // Add role to new rank pushers
    for (const userId of def.validSet) {
      const userObj = weeklyActive.find(m => m.userId === userId);
      if (userObj && !userObj.member.roles.cache.has(def.id)) {
        await userObj.member.roles.add(def.id);
        console.log(`    ✅ Added ${def.name} to: ${userObj.member.nickname || userObj.member.user.username}`);
      }
    }
  }
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
  
  return logData;
}

async function sendSummaryToDiscord(guild, logData) {
  try {
    const channel = await guild.channels.fetch(SUMMARY_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error('  ⚠️  Summary channel not found or not text-based.');
      return;
    }

    const formatList = (users) => {
      if (!users || users.length === 0) return null;
      return users.map(u => `- <@${u.userId}>`).join('\n');
    };

    let rosterMsg = `# Summary of Attendance\nBased on people who signed up in Yeek threads last ${DAYS_WE_CHECK} days\n`;    
    
    rosterMsg += `## Top ${TOP_COUNT} Members\n${formatList(logData.top40)}\n`;
    
    if (logData.specialRoles.length > 0 || logData.protected.length > 0) {
      rosterMsg += `## Qualified Special & Protected Roles\n${formatList(
        (logData.protected||[]).concat((logData.specialRoles||[]))
      )}\n`;
    }
    
    let changesMsg = `# Hierarch Role Changes Update\n`;
    let hasChanges = false;
    
    if (logData.rolesAdded.length > 0) {
      changesMsg += `## Role Added\n${formatList(logData.rolesAdded)}\n`;
      hasChanges = true;
    }

    if (logData.rolesRemoved.length > 0) {
      changesMsg += `## Role Removed\n${logData.rolesRemoved.map(u => `- <@${u.userId}> (${u.reason})`).join('\n')}\n`;
      hasChanges = true;
    }
    
    if (!hasChanges) {
      changesMsg += `- No role changes this week.`;
    }

    const embed = new EmbedBuilder()
      .setColor(0xFEFE92)
      .setDescription(
        `${rosterMsg + changesMsg}`
      );

    await channel.send({
      embeds: [embed],
    });

    console.log('  ✅ Discord summary sent.');

  } catch (err) {
    console.error('  ❌ Failed to send Discord summary:', err);
  }
}

client.login(TOKEN).catch(err => {
  console.error('Login failed:', err.message || err);
});