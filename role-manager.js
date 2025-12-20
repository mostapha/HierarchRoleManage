import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

config();

// Configuration
const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1247740449959968870';
const CHANNELS_IDS = ['1274705683283054652', '1280884277420228640', '1247901833188478996'];

// Role Configuration
const HIERARCH_ROLE_ID = '1449883199722229890';
const MEMBER_ROLE_ID = '1338515855709044757';

// Protected roles: Never touched by automation, always keep Hierarch
const PROTECTED_ROLES_IDS = [
  '1247895646929817730', // highlord
];

// Special roles: Don't compete for top 30 spots, but can lose Hierarch if inactive
const SPECIAL_ROLES_IDS = [
  '1265029315532161176', // chieftain
  '1247902423453007934', // shotcaller
  '1247902000847523912', // pt leader
  '1336680493252481037', // pt leader trial
];

const TOP_COUNT = 30;
const TWO_MONTHS_MS = 1000 * 60 * 60 * 24 * 60;

// Grace period: how many weeks someone can stay out of top 30 before losing role
// Set to 0 to disable grace period
const GRACE_PERIOD_WEEKS = 4;

const LOGS_DIR = './role-logs';
const GRACE_FILE = path.join(LOGS_DIR, 'grace-tracking.json');

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
    // Ensure logs directory exists
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    
    // Step 1: Scan channels and count mentions
    console.log('Step 1: Scanning channels for mentions...');
    const mentionCount = await scanChannelsForMentions(guild);
    
    // Step 2: Filter and get top 30 regular members (excludes special roles)
    console.log('\nStep 2: Filtering users and calculating top 30...');
    const eligibleUsers = await filterEligibleUsers(guild, mentionCount);
    const top30Regular = eligibleUsers.slice(0, TOP_COUNT);
    
    // Step 3: Get special role members who are active
    console.log('\nStep 3: Finding active special role members...');
    const activeSpecialRoles = await getActiveSpecialRoles(guild, mentionCount);
    
    // Step 4: Manage roles
    console.log('\nStep 4: Managing roles...');
    await manageRoles(guild, top30Regular, activeSpecialRoles);
    
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

        for (const user of message.mentions.users.values()) {
          mentionCount.set(user.id, (mentionCount.get(user.id) || 0) + 1);
        }
      }

      if (Date.now() - messages.last().createdTimestamp > TWO_MONTHS_MS) break;
      lastMessageId = messages.last().id;
    }
  }

  console.log(`  Total messages scanned: ${totalScanned}`);
  console.log(`  Unique users mentioned: ${mentionCount.size}`);
  
  return mentionCount;
}

async function filterEligibleUsers(guild, mentionCount) {
  const eligible = [];
  
  // Only fetch members who were actually mentioned
  for (const [userId, count] of mentionCount.entries()) {
    try {
      const member = await guild.members.fetch(userId);
      
      // Check if user has the Member role
      if (!member.roles.cache.has(MEMBER_ROLE_ID)) {
        continue;
      }
      
      // Check if user has any special or protected roles - exclude them from regular top 30
      const hasSpecialRole = member.roles.cache.some(role => 
        SPECIAL_ROLES_IDS.includes(role.id) || PROTECTED_ROLES_IDS.includes(role.id)
      );
      
      if (!hasSpecialRole) {
        eligible.push({
          userId,
          username: member.nickname || member.user.username,
          mentionCount: count,
          member
        });
      }
    } catch (err) {
      // User might have left the server
      console.log(`  ⚠️  Could not fetch user ${userId}`);
    }
  }
  
  // Sort by mention count (descending)
  eligible.sort((a, b) => b.mentionCount - a.mentionCount);
  
  console.log(`  Eligible regular users (after filtering): ${eligible.length}`);
  
  return eligible;
}

async function getActiveSpecialRoles(guild, mentionCount) {
  const activeSpecial = [];
  
  // Check special role holders who were mentioned
  for (const [userId, count] of mentionCount.entries()) {
    try {
      const member = await guild.members.fetch(userId);
      
      // Check if they have special roles (not protected)
      const hasSpecialRole = member.roles.cache.some(role => 
        SPECIAL_ROLES_IDS.includes(role.id)
      );
      
      if (hasSpecialRole) {
        activeSpecial.push({
          userId,
          username: member.nickname || member.user.username,
          mentionCount: count,
          member
        });
      }
    } catch (err) {
      console.log(`  ⚠️  Could not fetch user ${userId}`);
    }
  }
  
  console.log(`  Active special role members: ${activeSpecial.length}`);
  
  return activeSpecial;
}

async function manageRoles(guild, top30Regular, activeSpecialRoles) {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    top30: [],
    specialRoles: [],
    rolesAdded: [],
    rolesRemoved: [],
    graceUsers: [],
    protectedSkipped: []
  };

  // Load grace tracking data
  let graceTracking = {};
  if (fs.existsSync(GRACE_FILE)) {
    graceTracking = JSON.parse(fs.readFileSync(GRACE_FILE, 'utf8'));
  }

  // Track who is currently active (for clearing grace)
  const activeUsers = new Set();
  top30Regular.forEach(u => activeUsers.add(u.userId));
  activeSpecialRoles.forEach(u => activeUsers.add(u.userId));
  
  // Log top 30 regular members
  console.log('\n  📊 Top 30 Regular Members:');
  for (let i = 0; i < top30Regular.length; i++) {
    const user = top30Regular[i];
    console.log(`    ${i + 1}. ${user.username} - ${user.mentionCount} mentions`);
    logData.top30.push({
      rank: i + 1,
      username: user.username,
      userId: user.userId,
      mentions: user.mentionCount
    });
  }
  
  // Log active special roles
  if (activeSpecialRoles.length > 0) {
    console.log('\n  ⭐ Active Special Role Members:');
    activeSpecialRoles.forEach(user => {
      console.log(`    • ${user.username} - ${user.mentionCount} mentions`);
      logData.specialRoles.push({
        username: user.username,
        userId: user.userId,
        mentions: user.mentionCount
      });
    });
  }

  // Fetch role object to get members with Hierarch role
  const hierarchRole = await guild.roles.fetch(HIERARCH_ROLE_ID);
  if (!hierarchRole) {
    console.error('  ❌ Hierarch role not found!');
    return;
  }

  console.log('\n  🔄 Role Changes:');

  // Add role ONLY to top 30 regular members who don't have it
  for (const user of top30Regular) {
    // Clear grace tracking if they're in top 30
    if (graceTracking[user.userId]) {
      delete graceTracking[user.userId];
    }
    
    if (!user.member.roles.cache.has(HIERARCH_ROLE_ID)) {
      // await user.member.roles.add(HIERARCH_ROLE_ID);
      console.log(`    ✅ Added role to: ${user.username}`);
      logData.rolesAdded.push({
        username: user.username,
        userId: user.userId,
        mentions: user.mentionCount
      });
    }
  }

  // Clear grace for active special roles (they keep existing Hierarch if they have it)
  for (const user of activeSpecialRoles) {
    if (graceTracking[user.userId]) {
      delete graceTracking[user.userId];
    }
  }

  // Handle users who have the role but aren't active
  for (const [memberId] of hierarchRole.members) {
    if (!activeUsers.has(memberId)) {
      try {
        const member = await guild.members.fetch(memberId);
        const username = member.nickname || member.user.username;
        
        // Check if user has protected roles - never touch them
        const hasProtectedRole = member.roles.cache.some(role => 
          PROTECTED_ROLES_IDS.includes(role.id)
        );
        
        if (hasProtectedRole) {
          console.log(`    🛡️  Skipping protected user: ${username}`);
          logData.protectedSkipped.push({
            username,
            userId: memberId
          });
          continue;
        }
        
        // Regular grace period logic for everyone else
        if (GRACE_PERIOD_WEEKS > 0) {
          // Initialize or update grace tracking
          if (!graceTracking[memberId]) {
            graceTracking[memberId] = {
              username,
              weeksOut: 1,
              firstWeekOut: timestamp
            };
            console.log(`    ⏳ Grace period started for: ${username} (1/${GRACE_PERIOD_WEEKS} weeks)`);
            logData.graceUsers.push({
              username,
              userId: memberId,
              weeksOut: 1,
              weeksRemaining: GRACE_PERIOD_WEEKS - 1
            });
          } else {
            graceTracking[memberId].weeksOut++;
            const weeksOut = graceTracking[memberId].weeksOut;
            
            if (weeksOut > GRACE_PERIOD_WEEKS) {
              // Grace period expired, remove role
              // await member.roles.remove(HIERARCH_ROLE_ID);
              console.log(`    ❌ Removed role from: ${username} (grace period expired)`);
              logData.rolesRemoved.push({
                username,
                userId: memberId,
                reason: 'Grace period expired',
                weeksOut
              });
              delete graceTracking[memberId];
            } else {
              console.log(`    ⏳ Grace period continues for: ${username} (${weeksOut}/${GRACE_PERIOD_WEEKS} weeks)`);
              logData.graceUsers.push({
                username,
                userId: memberId,
                weeksOut,
                weeksRemaining: GRACE_PERIOD_WEEKS - weeksOut
              });
            }
          }
        } else {
          // No grace period, remove immediately
          // await member.roles.remove(HIERARCH_ROLE_ID);
          console.log(`    ❌ Removed role from: ${username}`);
          logData.rolesRemoved.push({
            username,
            userId: memberId,
            reason: 'Not in top 30'
          });
        }
      } catch (err) {
        console.log(`  ⚠️  Could not fetch member ${memberId}: ${err.message}`);
      }
    }
  }

  // Save grace tracking
  fs.writeFileSync(GRACE_FILE, JSON.stringify(graceTracking, null, 2), 'utf8');

  // Save detailed log
  const logFileName = `role-update-${new Date().toISOString().split('T')[0]}.json`;
  const logPath = path.join(LOGS_DIR, logFileName);
  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf8');

  // Create human-readable summary
  const summaryLines = [
    `Role Update Summary - ${new Date().toLocaleString()}`,
    `${'='.repeat(60)}`,
    '',
    `📊 TOP 30 REGULAR MEMBERS:`,
    ...logData.top30.map(u => `  ${u.rank}. ${u.username} - ${u.mentions} mentions`),
    ''
  ];

  if (logData.specialRoles.length > 0) {
    summaryLines.push(
      `⭐ ACTIVE SPECIAL ROLE MEMBERS (${logData.specialRoles.length}):`,
      ...logData.specialRoles.map(u => `  • ${u.username} - ${u.mentions} mentions`),
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

  if (GRACE_PERIOD_WEEKS > 0 && logData.graceUsers.length > 0) {
    summaryLines.push(
      `⏳ USERS IN GRACE PERIOD (${logData.graceUsers.length}):`,
      ...logData.graceUsers.map(u => 
        `  ~ ${u.username} (${u.weeksOut}/${GRACE_PERIOD_WEEKS} weeks, ${u.weeksRemaining} remaining)`
      ),
      ''
    );
  }

  if (logData.protectedSkipped.length > 0) {
    summaryLines.push(
      `🛡️  PROTECTED USERS SKIPPED (${logData.protectedSkipped.length}):`,
      ...logData.protectedSkipped.map(u => `  • ${u.username}`),
      ''
    );
  }

  summaryLines.push(
    `📈 TOTAL WITH HIERARCH: ${logData.top30.length + logData.specialRoles.length + logData.protectedSkipped.length + logData.graceUsers.length}`
  );

  const summaryPath = path.join(LOGS_DIR, 'latest-summary.txt');
  fs.writeFileSync(summaryPath, summaryLines.join('\n'), 'utf8');

  // Also save a timestamped copy for history
  const historySummaryFileName = `summary-${new Date().toISOString().split('T')[0]}.txt`;
  const historySummaryPath = path.join(LOGS_DIR, historySummaryFileName);
  fs.writeFileSync(historySummaryPath, summaryLines.join('\n'), 'utf8');

  console.log(`\n  📝 Logs saved to: ${LOGS_DIR}`);
  console.log(`     - Detailed JSON: ${logFileName}`);
  console.log(`     - Latest Summary: latest-summary.txt`);
  console.log(`     - History Summary: ${historySummaryFileName}`);
}

client.login(TOKEN).catch(err => {
  console.error('Login failed:', err.message || err);
});