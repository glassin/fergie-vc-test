const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} = require("@discordjs/voice");

const prism = require("prism-media");
const fs = require("fs");
const { spawn } = require("child_process");
const { Transform } = require("stream");

const TOKEN = process.env.DISCORD_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const FERGIE_BRAIN_URL = (process.env.FERGIE_BRAIN_URL || "").replace(/\/$/, "");
const VC_BRIDGE_SECRET = process.env.VC_BRIDGE_SECRET;
const FERGIE_DJ_URL = (process.env.FERGIE_DJ_URL || "").replace(/\/$/, "");
const FERGIE_DJ_API_KEY = process.env.FERGIE_DJ_API_KEY || "";

const VOICE_CHANCE_NORMAL = 0.05;
const VOICE_CHANCE_DIRECT = 1.00;
const VOICE_COOLDOWN_MS = 5 * 60 * 1000;

// Rare chance Fergie butts into a conversation
// even when nobody said her name.
const UNSOLICITED_RESPONSE_CHANCE = 0.05;

// Prevent her from randomly interrupting too often.
const UNSOLICITED_RESPONSE_COOLDOWN_MS = 2 * 60 * 1000;

const lastVoiceReplyAtByGuild = new Map();
const lastUnsolicitedReplyAtByGuild = new Map();
const autoListenStates = new Map();
const autoProcessingGuilds = new Set();

// Stage 6: persistent DJ playback state per Discord guild.
const djStates = new Map();

if (!TOKEN) {
  throw new Error("DISCORD_TOKEN environment variable is missing");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your current voice channel"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),

  new SlashCommandBuilder()
    .setName("djtest")
    .setDescription("Play DJ Fergie test track 2 in the current VC"),

  new SlashCommandBuilder()
    .setName("djsearch")
    .setDescription("Search DJ Fergie's local music crate")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Artist, song title, or album")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("djplay")
    .setDescription("Search DJ Fergie's crate and play or queue the best match")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Artist, song title, or album")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("djqueue")
    .setDescription("Show DJ Fergie's current song and queue"),

  new SlashCommandBuilder()
    .setName("djskip")
    .setDescription("Skip DJ Fergie's current song"),

  new SlashCommandBuilder()
    .setName("djstop")
    .setDescription("Stop DJ Fergie and clear the queue"),
].map((command) => command.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("FERGIE NODE VC TEST READY ✅");

  validateNaturalDjPlayParser();

  await checkFergieBrainHealth();
  await checkFergieDjHealth();
  await checkFergieDjCrateList();
  await checkFergieDjTrackFetch();

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );

    console.log("Slash commands registered ✅");
  } catch (error) {
    console.error("Slash command registration error:", error);
  }
});


function leaveVoiceForGuild(guildId) {
  const connection = getVoiceConnection(guildId);

  stopDjForGuild(guildId, true);

  if (connection) {
    connection.destroy();
  }

  autoListenStates.delete(guildId);
  lastVoiceReplyAtByGuild.delete(guildId);
  lastUnsolicitedReplyAtByGuild.delete(guildId);
  autoProcessingGuilds.delete(guildId);

  console.log(`AUTO LISTEN STOPPED ✅ guild=${guildId}`);

  return Boolean(connection);
}

// Natural spoken VC leave requests. Fergie must be directly addressed so
// normal conversation like "I should leave VC" cannot kick her out.
function isFergieLeaveRequest(transcript) {
  const text = (transcript || "").trim();

  if (!isFergieAddressed(text)) {
    return false;
  }

  const leaveIntent =
    /\b(?:leave|exit|disconnect|get\s+out|get\s+outta|get\s+off|go\s+away|bye|goodbye|adios|adiós|vete|salte)\b/i;

  const vcContext =
    /\b(?:vc|voice|voice\s+chat|call|channel|here)\b/i;

  // Strong leave verbs are enough when Fergie is addressed; softer bye/adios
  // wording requires VC/call context.
  const strongLeave =
    /\b(?:leave|exit|disconnect|get\s+out|get\s+outta|get\s+off|vete|salte)\b/i;

  return strongLeave.test(text) || (leaveIntent.test(text) && vcContext.test(text));
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!interaction.guild) {
    return;
  }

  // =========================
  // /join
  // =========================
  if (interaction.commandName === "join") {
    const member = interaction.member;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: "Join a voice channel first.",
        ephemeral: true,
      });
      return;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    startAutoListening(
      connection,
      interaction.guild,
      interaction.channel
    );

    await interaction.reply(
      `Joined **${voiceChannel.name}** ✅`
    );

    return;
  }

  // =========================
  // /leave
  // =========================
  if (interaction.commandName === "leave") {
    leaveVoiceForGuild(interaction.guild.id);

    await interaction.reply("Left VC.");

    return;
  }

  // =========================
  // /djsearch - Stage 4 crate search test (no playback)
  // =========================
  if (interaction.commandName === "djsearch") {
    const query = interaction.options.getString("query", true).trim();

    await interaction.deferReply();

    try {
      const results = await searchFergieDjCrate(query);

      if (!results.length) {
        await interaction.editReply(`🎧 No DJ crate matches for **${query}**.`);
        return;
      }

      const lines = results.slice(0, 10).map((track, index) => {
        const artist = track.artist || "Unknown artist";
        const title = track.title || "Unknown title";
        const album = track.album ? ` — ${track.album}` : "";
        return `${index + 1}. **${artist} — ${title}**${album} (track ${track.id})`;
      });

      await interaction.editReply(
        `🎧 DJ crate search for **${query}** (${results.length} match${results.length === 1 ? "" : "es"}):\n${lines.join("\n")}`
      );

      console.log(
        `FERGIE DJ SEARCH ✅ query=${JSON.stringify(query)} matches=${results.length}`
      );
    } catch (error) {
      console.error("FERGIE DJ SEARCH ❌", error);

      try {
        await interaction.editReply("❌ DJ crate search failed. Check the Railway logs.");
      } catch {}
    }

    return;
  }

  // =========================
  // /djplay - Stage 6 search + queue-aware playback
  // =========================
  if (interaction.commandName === "djplay") {
    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      await interaction.reply({
        content: "Fergie needs to be in VC first. Use /join.",
        ephemeral: true,
      });
      return;
    }

    const query = interaction.options.getString("query", true).trim();
    await interaction.deferReply();

    try {
      const results = await searchFergieDjCrate(query);

      if (!results.length) {
        await interaction.editReply(`🎧 No DJ crate matches for **${query}**.`);
        return;
      }

      const track = results[0];
      const state = getDjState(interaction.guild.id);
      const wasIdle = !state.current && !state.starting && state.queue.length === 0;

      state.queue.push(track);

      console.log(
        `FERGIE DJ QUEUE ADD ✅ guild=${interaction.guild.id} query=${JSON.stringify(query)} track=${track.id} queue=${state.queue.length}`
      );

      if (wasIdle) {
        await playNextDjTrack(interaction.guild.id);
      }

      const artist = track.artist || "Unknown artist";
      const title = track.title || "Unknown title";
      const nowPlayingThisTrack = state.current && String(state.current.id) === String(track.id);

      if (nowPlayingThisTrack) {
        await interaction.editReply(`🎧 DJ Fergie: playing **${artist} — ${title}**.`);
      } else {
        const position = state.queue.findIndex(
          (queued) => String(queued.id) === String(track.id)
        ) + 1;
        await interaction.editReply(
          `🎧 queued **${artist} — ${title}**${position > 0 ? ` (position ${position})` : ""}.`
        );
      }
    } catch (error) {
      console.error("FERGIE DJ PLAY/QUEUE ❌", error);

      try {
        await interaction.editReply("❌ DJ playback failed. Check the Railway logs.");
      } catch {}
    }

    return;
  }

  // =========================
  // /djqueue - Stage 6 queue status
  // =========================
  if (interaction.commandName === "djqueue") {
    const state = djStates.get(interaction.guild.id);

    if (!state || (!state.current && state.queue.length === 0)) {
      await interaction.reply("🎧 DJ Fergie's queue is empty.");
      return;
    }

    const lines = [];

    if (state.current) {
      lines.push(`**Now:** ${formatDjTrack(state.current)}`);
    }

    if (state.queue.length) {
      lines.push(
        "**Up next:**\n" +
        state.queue.slice(0, 10).map((track, index) =>
          `${index + 1}. ${formatDjTrack(track)}`
        ).join("\n")
      );
    }

    await interaction.reply(`🎧 **DJ Fergie queue**\n${lines.join("\n")}`);
    return;
  }

  // =========================
  // /djskip - Stage 6 skip current song
  // =========================
  if (interaction.commandName === "djskip") {
    const state = djStates.get(interaction.guild.id);

    if (!state || !state.current) {
      await interaction.reply("🎧 nothing is playing to skip.");
      return;
    }

    const skipped = formatDjTrack(state.current);
    state.player.stop(true);
    await interaction.reply(`⏭️ skipped **${skipped}**.`);
    return;
  }

  // =========================
  // /djstop - Stage 6 stop + clear queue
  // =========================
  if (interaction.commandName === "djstop") {
    const hadMusic = stopDjForGuild(interaction.guild.id, false);

    await interaction.reply(
      hadMusic
        ? "⏹️ DJ Fergie stopped. queue cleared."
        : "🎧 DJ Fergie isn't playing anything."
    );
    return;
  }

  // =========================
  // /djtest - controlled Stage 3 playback test
  // =========================
  if (interaction.commandName === "djtest") {
    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      await interaction.reply({
        content: "Fergie needs to be in VC first. Use /join.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    let trackFile = null;

    try {
      console.log(`FERGIE DJ PLAYBACK TEST START ▶️ guild=${interaction.guild.id} track=2`);
      trackFile = await fetchFergieDjTrackToTemp(2);
      await interaction.editReply("🎧 DJ Fergie test: playing **Billie Eilish — Skinny**.");
      await playSpeechInVC(connection, trackFile);
      trackFile = null; // playSpeechInVC owns/deletes the temp file after playback.
      console.log(`FERGIE DJ PLAYBACK TEST COMPLETE ✅ guild=${interaction.guild.id} track=2`);
    } catch (error) {
      if (trackFile) {
        try {
          fs.unlinkSync(trackFile);
        } catch {}
      }

      console.error("FERGIE DJ PLAYBACK TEST ❌", error);

      try {
        await interaction.editReply("❌ DJ Fergie test playback failed. Check the Railway logs.");
      } catch {}
    }

    return;
  }
});

// =========================
// STAGE 7A: NATURAL SPOKEN DJ PLAY REQUEST
// =========================
function getNaturalDjPlayQuery(transcript) {
  const text = String(transcript || "").trim();

  if (!isFergieAddressed(text)) {
    return null;
  }

  // Keep this intentionally narrow for the first spoken-DJ checkpoint.
  // Examples: "Fergie play The Greatest", "Fergie, play Skinny".
  const match = text.match(
    /\b(?:ferg(?:ie|i|y)?|erg(?:ie|i)|berg(?:ie|y))\b[\s,.:;!?-]*(?:please\s+)?plays?\s+(.+?)[\s.!?]*$/i
  );

  if (!match) {
    return null;
  }

  const query = String(match[1] || "")
    .replace(/^(?:the\s+song\s+|song\s+)/i, "")
    .trim();

  return query || null;
}

function validateNaturalDjPlayParser() {
  const cases = [
    ["Fergie, play Skinny", "Skinny"],
    ["Fergie plays Skinny", "Skinny"],
    ["Ergie, play Skinny", "Skinny"],
    ["Fergy play The Greatest", "The Greatest"],
  ];

  for (const [spoken, expected] of cases) {
    const actual = getNaturalDjPlayQuery(spoken);

    if (actual !== expected) {
      throw new Error(
        `Natural DJ parser self-check failed: ${JSON.stringify(spoken)} => ${JSON.stringify(actual)}`
      );
    }
  }

  console.log("FERGIE NATURAL DJ PARSER CHECK ✅");
}

// =========================
// STAGE 7B: NATURAL SPOKEN DJ CONTROLS
// =========================
function getNaturalDjControlIntent(transcript) {
  const text = String(transcript || "").trim();

  if (!isFergieAddressed(text)) {
    return null;
  }

  // Strip the direct address so the remaining phrase can stay simple/narrow.
  const command = text
    .replace(/^.*?\bferg(?:ie|i|y)?\b[\s,.:;!?-]*/i, "")
    .trim()
    .replace(/[.!?]+$/g, "")
    .trim();

  if (!command) {
    return null;
  }

  if (/^(?:please\s+)?(?:skip|skip\s+(?:this|the)(?:\s+song|\s+track)?|next(?:\s+song|\s+track)?)(?:\s+please)?$/i.test(command)) {
    return "skip";
  }

  if (/^(?:please\s+)?(?:stop(?:\s+(?:the\s+)?(?:music|song|track))?|stop\s+playing(?:\s+music)?)(?:\s+please)?$/i.test(command)) {
    return "stop";
  }

  if (/^(?:please\s+)?(?:what(?:'s| is)\s+next|whats\s+next|show(?:\s+me)?\s+(?:the\s+)?queue|what(?:'s| is)\s+(?:in\s+)?(?:the\s+)?queue|queue)(?:\s+please)?$/i.test(command)) {
    return "queue";
  }

  return null;
}

async function handleNaturalDjControlRequest(guildId, transcript, textChannel) {
  const intent = getNaturalDjControlIntent(transcript);

  if (!intent) {
    return false;
  }

  console.log(`AUTO NATURAL DJ CONTROL ✅ guild=${guildId} intent=${intent}`);

  if (intent === "skip") {
    const state = djStates.get(guildId);

    if (!state || !state.current) {
      try {
        await textChannel.send("🎧 nothing is playing to skip.");
      } catch {}
      return true;
    }

    const skipped = formatDjTrack(state.current);
    state.player.stop(true);

    try {
      await textChannel.send(`⏭️ skipped **${skipped}**.`);
    } catch {}
    return true;
  }

  if (intent === "stop") {
    const hadMusic = stopDjForGuild(guildId, false);

    try {
      await textChannel.send(
        hadMusic
          ? "⏹️ DJ Fergie stopped. queue cleared."
          : "🎧 DJ Fergie isn't playing anything."
      );
    } catch {}
    return true;
  }

  if (intent === "queue") {
    const state = djStates.get(guildId);

    try {
      if (!state || (!state.current && state.queue.length === 0)) {
        await textChannel.send("🎧 DJ Fergie's queue is empty.");
        return true;
      }

      const lines = [];

      if (state.current) {
        lines.push(`**Now:** ${formatDjTrack(state.current)}`);
      }

      if (state.queue.length) {
        lines.push(
          "**Up next:**\\n" +
          state.queue.slice(0, 10).map((track, index) =>
            `${index + 1}. ${formatDjTrack(track)}`
          ).join("\\n")
        );
      } else {
        lines.push("**Up next:** nothing queued.");
      }

      await textChannel.send(`🎧 **DJ Fergie queue**\\n${lines.join("\\n")}`);
    } catch (error) {
      console.error("AUTO NATURAL DJ QUEUE STATUS ❌", error);
    }

    return true;
  }

  return false;
}

async function handleNaturalDjPlayRequest(guildId, transcript, textChannel) {
  const query = getNaturalDjPlayQuery(transcript);

  if (!query) {
    return false;
  }

  console.log(
    `AUTO NATURAL DJ PLAY REQUEST ✅ guild=${guildId} query=${JSON.stringify(query)}`
  );

  const connection = getVoiceConnection(guildId);

  if (!connection) {
    try {
      await textChannel.send("🎧 I need to be in VC first.");
    } catch {}
    return true;
  }

  try {
    const results = await searchFergieDjCrate(query);

    if (!results.length) {
      await textChannel.send(`🎧 No DJ crate matches for **${query}**.`);
      return true;
    }

    const track = results[0];
    const state = getDjState(guildId);
    const wasIdle = !state.current && !state.starting && state.queue.length === 0;

    state.queue.push(track);

    console.log(
      `AUTO NATURAL DJ QUEUE ADD ✅ guild=${guildId} track=${track.id} queue=${state.queue.length}`
    );

    if (wasIdle) {
      await playNextDjTrack(guildId);
    }

    const artist = track.artist || "Unknown artist";
    const title = track.title || "Unknown title";
    const nowPlayingThisTrack =
      state.current && String(state.current.id) === String(track.id);

    if (nowPlayingThisTrack) {
      await textChannel.send(`🎧 DJ Fergie: playing **${artist} — ${title}**.`);
    } else {
      const position = state.queue.findIndex(
        (queued) => String(queued.id) === String(track.id)
      ) + 1;

      await textChannel.send(
        `🎧 queued **${artist} — ${title}**${position > 0 ? ` (position ${position})` : ""}.`
      );
    }
  } catch (error) {
    console.error("AUTO NATURAL DJ PLAY ❌", error);

    try {
      await textChannel.send("❌ DJ playback failed. Check the Railway logs.");
    } catch {}
  }

  return true;
}

// =========================
// AUTOMATIC VC LISTENER
// =========================
function startAutoListening(
  connection,
  guild,
  textChannel
) {
  const guildId = guild.id;

  if (autoListenStates.has(guildId)) {
    console.log(
      `AUTO LISTEN already active for guild ${guildId}`
    );
    return;
  }

  const activeUsers = new Set();

  autoListenStates.set(
    guildId,
    activeUsers
  );

  console.log(
    `AUTO LISTEN STARTED ✅ guild=${guildId}`
  );

  connection.receiver.speaking.on(
    "start",
    (userId) => {
      const member =
        guild.members.cache.get(userId);

      if (
        !member ||
        member.user.bot ||
        userId === client.user.id
      ) {
        return;
      }

      if (activeUsers.has(userId)) {
        return;
      }

      activeUsers.add(userId);

      console.log(
        `AUTO SPEAKING START: ${member.user.tag}`
      );

      const opusStream =
        connection.receiver.subscribe(
          userId,
          {
            end: {
              behavior:
                EndBehaviorType.AfterSilence,
              duration: 1200,
            },
          }
        );

      const decoder =
        new prism.opus.Decoder({
          rate: 48000,
          channels: 2,
          frameSize: 960,
        });

      const pcmChunks = [];

      opusStream
        .pipe(decoder)

        .on(
          "data",
          (chunk) => {
            pcmChunks.push(
              Buffer.from(chunk)
            );
          }
        )

        .on(
          "error",
          (error) => {
            console.error(
              `AUTO DECODER ERROR ${member.user.tag}:`,
              error
            );

            activeUsers.delete(userId);
          }
        )

        .on(
          "end",
          async () => {
            activeUsers.delete(userId);

            const pcm =
              Buffer.concat(
                pcmChunks
              );

            console.log(
              `AUTO PCM COMPLETE ${member.user.tag}: ` +
              `${pcm.length} bytes`
            );

            if (pcm.length < 96000) {
              console.log(
                `AUTO IGNORE tiny audio from ${member.user.tag}`
              );
              return;
            }

            const wav =
              createWavBuffer(
                pcm,
                48000,
                2,
                16
              );

            try {
              const transcript =
                await transcribeWithElevenLabs(
                  wav
                );

              if (!transcript) {
                return;
              }

              console.log(
                `AUTO HEARD ${member.displayName}: ` +
                `"${transcript}"`
              );

              // Natural spoken leave command.
              // Examples: "Fergie leave VC", "Fergie get out", "Fergie disconnect",
              // "Fergie vete", "Fergie salte del voice chat".
              if (isFergieLeaveRequest(transcript)) {
                console.log(
                  `AUTO NATURAL LEAVE REQUEST ✅ guild=${guildId} user=${member.user.tag}`
                );

                try {
                  await textChannel.send("ugh fine. i'm leaving. 🙄");
                } catch (error) {
                  console.error("AUTO LEAVE TEXT ERROR:", error);
                }

                leaveVoiceForGuild(guildId);
                return;
              }

              // Stage 7B: intercept narrow natural spoken DJ controls before
              // play requests and normal brain/TTS handling. These reuse the
              // same proven Stage 6 queue/player state as the slash commands.
              if (
                await handleNaturalDjControlRequest(
                  guildId,
                  transcript,
                  textChannel
                )
              ) {
                return;
              }

              // Stage 7A: intercept a narrow natural spoken play request before
              // normal brain/TTS handling, and reuse the proven Stage 6 DJ engine.
              if (
                await handleNaturalDjPlayRequest(
                  guildId,
                  transcript,
                  textChannel
                )
              ) {
                return;
              }

              const responseDecision =
                shouldFergieRespond(
                  guildId,
                  transcript
                );

              console.log(
                `AUTO RESPONSE DECISION: ${responseDecision.reason}`
              );

              if (
                !responseDecision.respond
              ) {
                return;
              }

              const directlyAddressed =
                isFergieAddressed(transcript);

              if (!directlyAddressed) {
                lastUnsolicitedReplyAtByGuild.set(
                  guildId,
                  Date.now()
                );

                console.log(
                  "AUTO UNSOLICITED RESPONSE TRIGGERED 👀"
                );
              }

              const fergieReply =
                await askFergieBrain(
                  userId,
                  member.displayName,
                  transcript
                );

              if (!fergieReply) {
                return;
              }

              console.log(
                `AUTO FERGIE REPLY: ${fergieReply}`
              );

              await textChannel.send(
                `💬 **Fergie:** ${fergieReply}`
              );

              const voiceDecision =
                shouldFergieSpeak(
                  guildId,
                  transcript
                );

              console.log(
                `AUTO VOICE DECISION: ${voiceDecision.reason}`
              );

              if (
                !voiceDecision.speak
              ) {
                return;
              }

              // Stage 7C.2: while DJ music is active, generate Fergie's normal
              // TTS but inject the decoded speech PCM into the SAME persistent DJ
              // mixer/player. This avoids subscribing a second player and lets the
              // song continue underneath her voice.
              const activeDjState = djStates.get(guildId);
              const djMusicActive = Boolean(
                activeDjState &&
                activeDjState.current &&
                activeDjState.mixer &&
                !activeDjState.mixer.destroyed
              );

              try {
                console.log(
                  "AUTO generating Fergie voice..."
                );

                const speechFile =
                  await generateFergieSpeech(
                    fergieReply,
                    userId
                  );

                if (djMusicActive) {
                  const mixed =
                    await mixFergieSpeechIntoDj(
                      guildId,
                      speechFile
                    );

                  if (!mixed) {
                    // The song ended while speech was being prepared. At that
                    // point the DJ subscription is gone, so normal TTS is safe.
                    await playSpeechInVC(
                      connection,
                      speechFile
                    );
                  }
                } else {
                  await playSpeechInVC(
                    connection,
                    speechFile
                  );
                }

                lastVoiceReplyAtByGuild.set(
                  guildId,
                  Date.now()
                );

                console.log(
                  "AUTO FERGIE VC PLAYBACK COMPLETE ✅"
                );
              } catch (error) {
                console.error(
                  "AUTO TTS/playback error:",
                  error
                );
              }
            } catch (error) {
              console.error(
                `AUTO PROCESSING ERROR ${member.user.tag}:`,
                error
              );
            }
          }
        );
    }
  );
}

// =========================
// CREATE WAV FILE
// =========================
function createWavBuffer(
  pcmBuffer,
  sampleRate,
  channels,
  bitsPerSample
) {
  const blockAlign =
    channels *
    (bitsPerSample / 8);

  const byteRate =
    sampleRate * blockAlign;

  const dataSize =
    pcmBuffer.length;

  const buffer =
    Buffer.alloc(
      44 + dataSize
    );

  buffer.write(
    "RIFF",
    0
  );

  buffer.writeUInt32LE(
    36 + dataSize,
    4
  );

  buffer.write(
    "WAVE",
    8
  );

  buffer.write(
    "fmt ",
    12
  );

  buffer.writeUInt32LE(
    16,
    16
  );

  buffer.writeUInt16LE(
    1,
    20
  );

  buffer.writeUInt16LE(
    channels,
    22
  );

  buffer.writeUInt32LE(
    sampleRate,
    24
  );

  buffer.writeUInt32LE(
    byteRate,
    28
  );

  buffer.writeUInt16LE(
    blockAlign,
    32
  );

  buffer.writeUInt16LE(
    bitsPerSample,
    34
  );

  buffer.write(
    "data",
    36
  );

  buffer.writeUInt32LE(
    dataSize,
    40
  );

  pcmBuffer.copy(
    buffer,
    44
  );

  return buffer;
}

// =========================
// ELEVENLABS SPEECH-TO-TEXT
// =========================
async function transcribeWithElevenLabs(
  wavBuffer
) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is missing"
    );
  }

  const form =
    new FormData();

  form.append(
    "file",
    new Blob(
      [wavBuffer],
      {
        type: "audio/wav",
      }
    ),
    "fergie_vc_test.wav"
  );

  form.append(
    "model_id",
    "scribe_v2"
  );

  const response =
    await fetch(
      "https://api.elevenlabs.io/v1/speech-to-text",
      {
        method: "POST",

        headers: {
          "xi-api-key":
            ELEVENLABS_API_KEY,
        },

        body: form,
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `ElevenLabs STT failed: ${response.status} ${errorText}`
    );
  }

  const result =
    await response.json();

  return (
    result.text || ""
  ).trim();
}

// =========================
// REAL FERGIE BRAIN BRIDGE
// =========================
async function askFergieBrain(
  userId,
  displayName,
  transcript
) {
  if (!FERGIE_BRAIN_URL) {
    throw new Error(
      "FERGIE_BRAIN_URL is missing"
    );
  }

  if (!VC_BRIDGE_SECRET) {
    throw new Error(
      "VC_BRIDGE_SECRET is missing"
    );
  }

  const response =
    await fetch(
      `${FERGIE_BRAIN_URL}/vc-brain`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "X-VC-Bridge-Secret":
            VC_BRIDGE_SECRET,
        },

        body: JSON.stringify({
          user_id: userId,
          display_name:
            displayName || "Unknown member",
          transcript: transcript,
        }),
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Fergie brain bridge failed: ${response.status} ${errorText}`
    );
  }

  const result =
    await response.json();

  if (!result?.ok) {
    throw new Error(
      `Fergie brain bridge returned an error: ${JSON.stringify(result)}`
    );
  }

  return (
    result.reply || ""
  ).trim();
}

// =========================
// FERGIE BRAIN HEALTH CHECK
// =========================
async function checkFergieBrainHealth() {
  if (!FERGIE_BRAIN_URL) {
    console.error(
      "FERGIE BRAIN CONNECTION ❌ FERGIE_BRAIN_URL is missing"
    );
    return false;
  }

  try {
    const response = await fetch(
      `${FERGIE_BRAIN_URL}/health`
    );

    if (!response.ok) {
      console.error(
        `FERGIE BRAIN CONNECTION ❌ status=${response.status}`
      );
      return false;
    }

    const result = await response.json();

    if (!result?.ok) {
      console.error(
        `FERGIE BRAIN CONNECTION ❌ invalid response=${JSON.stringify(result)}`
      );
      return false;
    }

    console.log(
      "FERGIE BRAIN CONNECTION ✅"
    );

    return true;
  } catch (error) {
    console.error(
      "FERGIE BRAIN CONNECTION ❌",
      error
    );

    return false;
  }
}



// =========================
// FERGIE DJ HEALTH CHECK
// =========================
async function checkFergieDjHealth() {
  if (!FERGIE_DJ_URL) {
    console.warn(
      "FERGIE DJ CONNECTION ⚪ FERGIE_DJ_URL is missing"
    );
    return false;
  }

  if (!FERGIE_DJ_API_KEY) {
    console.warn(
      "FERGIE DJ CONNECTION ⚪ FERGIE_DJ_API_KEY is missing"
    );
    return false;
  }

  try {
    const response = await fetch(
      `${FERGIE_DJ_URL}/crate/status`,
      {
        method: "GET",
        headers: {
          "X-Fergie-DJ-Key":
            FERGIE_DJ_API_KEY,
        },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      console.warn(
        `FERGIE DJ CONNECTION ⚪ status=${response.status}`
      );
      return false;
    }

    const result = await response.json();

    if (!result?.ok) {
      console.warn(
        `FERGIE DJ CONNECTION ⚪ invalid response=${JSON.stringify(result)}`
      );
      return false;
    }

    console.log(
      `FERGIE DJ CONNECTION ✅ tracks=${result.tracks ?? "unknown"}`
    );

    return true;
  } catch (error) {
    console.warn(
      "FERGIE DJ CONNECTION ⚪ offline/unreachable:",
      error?.message || error
    );
    return false;
  }
}


async function checkFergieDjCrateList() {
  if (!FERGIE_DJ_URL || !FERGIE_DJ_API_KEY) {
    console.warn("FERGIE DJ CRATE LIST ⚪ DJ configuration is missing");
    return false;
  }

  try {
    const response = await fetch(
      `${FERGIE_DJ_URL}/crate/list`,
      {
        method: "GET",
        headers: {
          "X-Fergie-DJ-Key":
            FERGIE_DJ_API_KEY,
        },
        signal:
          AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      console.warn(
        `FERGIE DJ CRATE LIST ⚪ status=${response.status}`
      );
      return false;
    }

    const result =
      await response.json();

    if (
      !result?.ok ||
      !Array.isArray(result?.tracks)
    ) {
      console.warn(
        `FERGIE DJ CRATE LIST ⚪ invalid response=${JSON.stringify(result)}`
      );
      return false;
    }

    console.log(
      `FERGIE DJ CRATE LIST ✅ tracks=${result.tracks.length}`
    );

    return true;
  } catch (error) {
    console.warn(
      "FERGIE DJ CRATE LIST ⚪ offline/unreachable:",
      error?.message || error
    );
    return false;
  }
}


// =========================
// FERGIE DJ TRACK FETCH CHECK
// =========================
async function checkFergieDjTrackFetch() {
  if (!FERGIE_DJ_URL || !FERGIE_DJ_API_KEY) {
    console.warn("FERGIE DJ TRACK FETCH ⚪ DJ configuration is missing");
    return false;
  }

  try {
    const response = await fetch(
      `${FERGIE_DJ_URL}/track/2`,
      {
        method: "GET",
        headers: {
          "X-Fergie-DJ-Key": FERGIE_DJ_API_KEY,
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      console.warn(`FERGIE DJ TRACK FETCH ⚪ status=${response.status}`);
      return false;
    }

    const contentType = response.headers.get("content-type") || "unknown";
    const audio = await response.arrayBuffer();
    const bytes = audio.byteLength;

    if (bytes < 1024) {
      console.warn(`FERGIE DJ TRACK FETCH ⚪ response too small: ${bytes} bytes`);
      return false;
    }

    console.log(
      `FERGIE DJ TRACK FETCH ✅ track=2 bytes=${bytes} content-type=${contentType}`
    );
    return true;
  } catch (error) {
    console.warn(
      "FERGIE DJ TRACK FETCH ⚪ offline/unreachable:",
      error?.message || error
    );
    return false;
  }
}

// =========================
// STAGE 7C.2 SINGLE-PLAYER DJ MIXER
// =========================
// Discord voice connections effectively receive one subscribed audio player.
// To let Fergie speak without stealing the DJ subscription, music and TTS are
// mixed here as 48 kHz stereo s16le PCM and sent through the SAME DJ player.
//
// Music remains at full volume normally. While TTS samples are present, music
// is ducked to 18% and Fergie's voice is mixed over it. The music decoder never
// stops, so the track keeps its position underneath her speech.

const DJ_MUSIC_NORMAL_VOLUME = 0.80;
const DJ_MUSIC_DUCK_VOLUME = 0.20;
const DJ_SPEECH_VOLUME = 1.0;

function clampPcm16(value) {
  if (value > 32767) {
    return 32767;
  }

  if (value < -32768) {
    return -32768;
  }

  return Math.round(value);
}

class FergieDjMixer extends Transform {
  constructor(guildId) {
    super();

    this.guildId = guildId;
    this.speechQueue = [];
    this.musicRemainder = Buffer.alloc(0);
  }

  hasSpeech() {
    return this.speechQueue.length > 0;
  }

  enqueueSpeech(pcmBuffer) {
    if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < 2) {
      return Promise.reject(
        new Error("Fergie DJ mixer received empty speech PCM")
      );
    }

    return new Promise((resolve, reject) => {
      this.speechQueue.push({
        buffer: pcmBuffer,
        offset: 0,
        resolve,
        reject,
      });

      console.log(
        `FERGIE DJ MIX SPEECH QUEUED 🗣️ guild=${this.guildId} bytes=${pcmBuffer.length}`
      );
    });
  }

  _finishSpeechSegment(segment) {
    if (!segment) {
      return;
    }

    try {
      segment.resolve();
    } catch {}
  }

  _rejectQueuedSpeech(error) {
    while (this.speechQueue.length) {
      const segment = this.speechQueue.shift();

      try {
        segment.reject(error);
      } catch {}
    }
  }

  _mixPcm(musicBuffer) {
    const output = Buffer.allocUnsafe(musicBuffer.length);

    for (let offset = 0; offset + 1 < musicBuffer.length; offset += 2) {
      const musicSample = musicBuffer.readInt16LE(offset);
      let mixedSample = clampPcm16(
        musicSample * DJ_MUSIC_NORMAL_VOLUME
      );

      if (this.speechQueue.length) {
        const segment = this.speechQueue[0];

        if (segment.offset + 1 < segment.buffer.length) {
          const speechSample =
            segment.buffer.readInt16LE(segment.offset);

          segment.offset += 2;

          mixedSample = clampPcm16(
            (musicSample * DJ_MUSIC_DUCK_VOLUME) +
            (speechSample * DJ_SPEECH_VOLUME)
          );
        }

        if (segment.offset >= segment.buffer.length) {
          this.speechQueue.shift();
          this._finishSpeechSegment(segment);

          console.log(
            `FERGIE DJ MIX SPEECH COMPLETE ✅ guild=${this.guildId}`
          );
        }
      }

      output.writeInt16LE(mixedSample, offset);
    }

    return output;
  }

  _transform(chunk, encoding, callback) {
    try {
      let pcm = Buffer.from(chunk);

      if (this.musicRemainder.length) {
        pcm = Buffer.concat([
          this.musicRemainder,
          pcm,
        ]);

        this.musicRemainder = Buffer.alloc(0);
      }

      // s16le samples are 2 bytes. Preserve a rare split byte for the next
      // transform call so sample boundaries can never be corrupted.
      if (pcm.length % 2 !== 0) {
        this.musicRemainder =
          Buffer.from(
            pcm.subarray(
              pcm.length - 1
            )
          );

        pcm =
          pcm.subarray(
            0,
            pcm.length - 1
          );
      }

      if (pcm.length) {
        this.push(
          this._mixPcm(pcm)
        );
      }

      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      // If the song ends while Fergie is still speaking, finish her remaining
      // speech over silence before the resource goes Idle.
      while (this.speechQueue.length) {
        const segment = this.speechQueue.shift();
        const remaining =
          segment.buffer.subarray(
            segment.offset
          );

        if (remaining.length) {
          this.push(
            Buffer.from(remaining)
          );
        }

        this._finishSpeechSegment(segment);
      }

      callback();
    } catch (error) {
      callback(error);
    }
  }

  _destroy(error, callback) {
    const reason =
      error ||
      new Error(
        "Fergie DJ mixer stopped before speech completed"
      );

    this._rejectQueuedSpeech(reason);
    callback(error);
  }
}

function formatDjTrack(track) {
  const artist = track?.artist || "Unknown artist";
  const title = track?.title || "Unknown title";
  return `${artist} — ${title}`;
}

function cleanupDjTempFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function stopDjDecoder(state) {
  if (!state?.decoderProcess) {
    return;
  }

  try {
    state.decoderProcess.kill("SIGKILL");
  } catch {}

  state.decoderProcess = null;
}

function destroyDjMixer(state) {
  if (!state?.mixer) {
    return;
  }

  try {
    state.mixer.destroy();
  } catch {}

  state.mixer = null;
}

function cleanupDjTrackPipeline(state) {
  stopDjDecoder(state);
  destroyDjMixer(state);

  cleanupDjTempFile(
    state.currentFile
  );

  state.currentFile = null;
}

function spawnDjMusicDecoder(trackFile, guildId) {
  const decoder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      trackFile,
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    }
  );

  let stderr = "";

  decoder.stderr.on(
    "data",
    (chunk) => {
      stderr += chunk.toString();

      if (stderr.length > 4000) {
        stderr =
          stderr.slice(-4000);
      }
    }
  );

  decoder.once(
    "error",
    (error) => {
      console.error(
        `FERGIE DJ FFMPEG START ❌ guild=${guildId}`,
        error
      );
    }
  );

  decoder.once(
    "close",
    (code, signal) => {
      if (
        code !== 0 &&
        signal !== "SIGKILL"
      ) {
        console.error(
          `FERGIE DJ FFMPEG EXIT ❌ guild=${guildId} code=${code} signal=${signal || "none"} ${stderr.trim()}`
        );
      }
    }
  );

  return decoder;
}

async function decodeSpeechFileToPcm(
  speechFile,
  guildId
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const decoder = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          speechFile,
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "pipe:1",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        }
      );

      const chunks = [];
      let stderr = "";
      let settled = false;

      const fail =
        (error) => {
          if (settled) {
            return;
          }

          settled = true;

          try {
            decoder.kill("SIGKILL");
          } catch {}

          reject(error);
        };

      decoder.stdout.on(
        "data",
        (chunk) => {
          chunks.push(
            Buffer.from(chunk)
          );
        }
      );

      decoder.stderr.on(
        "data",
        (chunk) => {
          stderr += chunk.toString();

          if (stderr.length > 4000) {
            stderr =
              stderr.slice(-4000);
          }
        }
      );

      decoder.once(
        "error",
        (error) => {
          fail(error);
        }
      );

      decoder.once(
        "close",
        (code) => {
          if (settled) {
            return;
          }

          if (code !== 0) {
            settled = true;

            reject(
              new Error(
                `Fergie DJ speech ffmpeg failed (${code}): ${stderr.trim()}`
              )
            );
            return;
          }

          const pcm =
            Buffer.concat(
              chunks
            );

          if (pcm.length < 2) {
            settled = true;

            reject(
              new Error(
                "Fergie DJ speech decoder returned empty PCM"
              )
            );
            return;
          }

          settled = true;

          console.log(
            `FERGIE DJ SPEECH PCM ✅ guild=${guildId} bytes=${pcm.length}`
          );

          resolve(pcm);
        }
      );
    }
  );
}

async function mixFergieSpeechIntoDj(
  guildId,
  speechFile
) {
  const state =
    djStates.get(
      guildId
    );

  if (
    !state ||
    !state.current ||
    !state.mixer ||
    state.mixer.destroyed
  ) {
    return false;
  }

  const mixer =
    state.mixer;

  let pcm;

  try {
    pcm =
      await decodeSpeechFileToPcm(
        speechFile,
        guildId
      );
  } catch (error) {
    cleanupDjTempFile(
      speechFile
    );

    throw error;
  }

  // The music may have ended while ElevenLabs/ffmpeg were preparing speech.
  // If so, leave the MP3 intact so the caller can fall back to normal TTS.
  if (
    !state.current ||
    state.mixer !== mixer ||
    mixer.destroyed
  ) {
    return false;
  }

  cleanupDjTempFile(
    speechFile
  );

  console.log(
    `FERGIE DJ DUCK START 🔉 guild=${guildId} music=${DJ_MUSIC_DUCK_VOLUME}`
  );

  await mixer.enqueueSpeech(
    pcm
  );

  console.log(
    `FERGIE DJ DUCK END 🔊 guild=${guildId} music=1`
  );

  return true;
}

function getDjState(guildId) {
  let state = djStates.get(guildId);

  if (state) {
    return state;
  }

  const player = createAudioPlayer();

  state = {
    player,
    subscription: null,
    queue: [],
    current: null,
    currentFile: null,
    starting: false,
    intentionallyStopping: false,
    mixer: null,
    decoderProcess: null,

    // Stage 8A autonomous continuation state.
    autonomousEnabled: true,
    lastTrackId: null,

    // H.2 autonomous spoken DJ intro state.
    pendingAutonomousIntroTrackId: null,
    autonomousIntroInFlight: false,
    previousTrack: null,
    lastAutonomousIntroText: null,
    autonomousTracksSinceSpeech: 0,

    // H.3 smart autonomous selection memory.
    recentAutonomousTrackIds: [],
    recentAutonomousArtists: [],
  };

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(
      `FERGIE DJ PLAYING 🔊 guild=${guildId} track=${state.current?.id ?? "unknown"}`
    );
  });

  player.on(AudioPlayerStatus.Idle, () => {
    const finishedTrack = state.current;

    cleanupDjTrackPipeline(
      state
    );

    if (finishedTrack?.id != null) {
      state.lastTrackId = finishedTrack.id;
      state.previousTrack = {
        ...finishedTrack,
      };
    }

    state.current = null;

    if (state.intentionallyStopping) {
      state.intentionallyStopping = false;
      return;
    }

    setImmediate(async () => {
      try {
        if (
          state.autonomousEnabled &&
          state.queue.length === 0 &&
          finishedTrack
        ) {
          await queueAutonomousDjTrack(
            guildId
          );
        }

        await playNextDjTrack(
          guildId
        );
      } catch (error) {
        console.error(
          `FERGIE DJ NEXT TRACK ❌ guild=${guildId}`,
          error
        );
      }
    });
  });

  player.on("error", (error) => {
    console.error(`FERGIE DJ PLAYER ERROR ❌ guild=${guildId}`, error);

    cleanupDjTrackPipeline(
      state
    );

    state.current = null;

    setImmediate(() => {
      playNextDjTrack(guildId).catch((nextError) => {
        console.error(`FERGIE DJ RECOVERY ❌ guild=${guildId}`, nextError);
      });
    });
  });

  djStates.set(guildId, state);
  return state;
}


async function fetchDjTasteSignals() {
  // J.4: failure is intentionally harmless. Autonomous DJ falls back to
  // the exact existing random-selection behavior.
  if (
    !FERGIE_BRAIN_URL ||
    !VC_BRIDGE_SECRET
  ) {
    return {};
  }

  try {
    const response = await fetch(
      `${FERGIE_BRAIN_URL}/dj-taste-signals`,
      {
        method: "GET",
        headers: {
          "X-VC-Bridge-Secret":
            VC_BRIDGE_SECRET,
        },
        signal:
          AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      return {};
    }

    const result =
      await response.json();

    if (
      !result?.ok ||
      !result?.artist_signals ||
      typeof result.artist_signals !== "object"
    ) {
      return {};
    }

    return result.artist_signals;
  } catch (error) {
    console.warn(
      `FERGIE DJ TASTE SIGNAL ⚪ fallback=random reason=${error?.message || error}`
    );
    return {};
  }
}


function djTasteWeight(track, artistSignals) {
  const artist =
    String(
      track?.artist || ""
    ).trim().toLowerCase();

  if (!artist) {
    return 1.0;
  }

  const rawHits =
    Number(
      artistSignals?.[artist] || 0
    );

  const hits =
    Number.isFinite(rawHits)
      ? Math.max(
          0,
          Math.min(4, rawHits)
        )
      : 0;

  // Maximum influence is +8%. Randomness remains overwhelmingly dominant.
  return 1.0 + (hits * 0.02);
}


function chooseTasteNudgedTrack(pool, artistSignals) {
  if (
    !Array.isArray(pool) ||
    !pool.length
  ) {
    return null;
  }

  const weights =
    pool.map(
      (track) =>
        djTasteWeight(
          track,
          artistSignals
        )
    );

  const total =
    weights.reduce(
      (sum, weight) =>
        sum + weight,
      0
    );

  let roll =
    Math.random() * total;

  for (
    let i = 0;
    i < pool.length;
    i += 1
  ) {
    roll -= weights[i];

    if (roll <= 0) {
      const chosen = pool[i];

      if (weights[i] > 1.0) {
        console.log(
          `FERGIE DJ TASTE NUDGE 🧠 artist=${chosen?.artist || "Unknown artist"} bonus=${(weights[i] - 1.0).toFixed(2)}`
        );
      }

      return chosen;
    }
  }

  return pool[
    Math.floor(
      Math.random() *
        pool.length
    )
  ];
}

async function queueAutonomousDjTrack(guildId) {
  const state = getDjState(guildId);

  if (
    !state.autonomousEnabled ||
    state.current ||
    state.starting ||
    state.queue.length
  ) {
    return null;
  }

  // Stage 8A.2: autonomous continuation uses the dedicated crate-list
  // endpoint from the local DJ server. This returns real track objects and
  // avoids guessing IDs or abusing the search endpoint.
  const response = await fetch(
    `${FERGIE_DJ_URL}/crate/list`,
    {
      method: "GET",
      headers: {
        "X-Fergie-DJ-Key":
          FERGIE_DJ_API_KEY,
      },
      signal:
        AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Fergie DJ autonomous crate list failed: ${response.status} ${errorText}`
    );
  }

  const result =
    await response.json();

  const crate =
    Array.isArray(result?.tracks)
      ? result.tracks
      : [];

  if (
    !result?.ok ||
    crate.length === 0
  ) {
    console.warn(
      `FERGIE DJ AUTONOMOUS ⚪ crate list empty/unavailable guild=${guildId}`
    );
    return null;
  }

  const recentIds =
    new Set(
      state.recentAutonomousTrackIds.map(
        (id) => String(id)
      )
    );

  const lastArtist =
    String(
      state.recentAutonomousArtists[
        state.recentAutonomousArtists.length - 1
      ] || ""
    ).trim().toLowerCase();

  let pool =
    crate.filter(
      (track) =>
        !recentIds.has(
          String(track?.id)
        )
    );

  if (!pool.length) {
    pool = [...crate];
  }

  const differentArtistPool =
    pool.filter(
      (track) => {
        const artist =
          String(
            track?.artist || ""
          ).trim().toLowerCase();

        return (
          !lastArtist ||
          !artist ||
          artist === "unknown artist" ||
          artist !== lastArtist
        );
      }
    );

  if (differentArtistPool.length) {
    pool = differentArtistPool;
  }

  const immediateNonRepeat =
    pool.filter(
      (track) =>
        String(track?.id) !==
        String(state.lastTrackId)
    );

  if (immediateNonRepeat.length) {
    pool = immediateNonRepeat;
  }

  // J.4: all proven H.3 rotation filters above remain authoritative.
  // Taste is only a tiny final-stage weighting nudge.
  const artistSignals =
    await fetchDjTasteSignals();

  const chosen =
    chooseTasteNudgedTrack(
      pool,
      artistSignals
    );

  if (!chosen) {
    return null;
  }

  const chosenArtist =
    String(
      chosen?.artist || ""
    ).trim();

  state.recentAutonomousTrackIds.push(
    chosen.id
  );

  state.recentAutonomousArtists.push(
    chosenArtist
  );

  while (
    state.recentAutonomousTrackIds.length > 3
  ) {
    state.recentAutonomousTrackIds.shift();
  }

  while (
    state.recentAutonomousArtists.length > 3
  ) {
    state.recentAutonomousArtists.shift();
  }

  state.queue.push(
    chosen
  );

  state.pendingAutonomousIntroTrackId =
    chosen.id;

  console.log(
    `FERGIE DJ AUTONOMOUS PICK 🤖 guild=${guildId} track=${chosen.id} title=${JSON.stringify(formatDjTrack(chosen))} recent=${JSON.stringify(state.recentAutonomousTrackIds)}`
  );

  return chosen;
}

function buildAutonomousDjIntro(
  track,
  previousTrack,
  lastIntroText,
  tracksSinceSpeech
) {
  const artist = String(track?.artist || "").trim();
  const title = String(track?.title || "").trim();
  const hasArtist =
    artist && artist.toLowerCase() !== "unknown artist";
  const trackLabel =
    hasArtist ? `${title} by ${artist}` : title;

  const previousArtist =
    String(previousTrack?.artist || "").trim();
  const previousTitle =
    String(previousTrack?.title || "").trim();
  const hasPrevious = Boolean(previousTitle);
  const previousHasArtist =
    previousArtist &&
    previousArtist.toLowerCase() !== "unknown artist";
  const previousLabel =
    hasPrevious
      ? (previousHasArtist
          ? `${previousTitle} by ${previousArtist}`
          : previousTitle)
      : "";

  // Usually let some transitions breathe, but never stay silent forever.
  if (
    Number(tracksSinceSpeech || 0) < 2 &&
    Math.random() < 0.25
  ) {
    return null;
  }

  const sameArtist =
    hasPrevious &&
    previousHasArtist &&
    hasArtist &&
    previousArtist.toLowerCase() === artist.toLowerCase();

  const simple = [
    `Up next, ${trackLabel}.`,
    `Alright, next one. ${trackLabel}.`,
    `Okay, this one's ${trackLabel}.`,
    `Next up, ${trackLabel}.`,
    `Here comes ${trackLabel}.`,
    `We're going with ${trackLabel} next.`,
  ];

  const contextual = hasPrevious
    ? [
        `That was ${previousLabel}. Now we're going into ${trackLabel}.`,
        `${previousLabel} is done. Next up, ${trackLabel}.`,
        `From ${previousLabel} into ${trackLabel}.`,
        `Alright, leaving ${previousLabel} behind. Here's ${trackLabel}.`,
      ]
    : [];

  const sameArtistLines = sameArtist
    ? [
        `Staying with ${artist}. This one's ${title}.`,
        `More ${artist}. Here's ${title}.`,
        `${artist} gets another one. ${title}.`,
      ]
    : [];

  let candidates = [
    ...simple,
    ...contextual,
    ...sameArtistLines,
  ].filter((line) => line !== lastIntroText);

  if (!candidates.length) {
    candidates = [`Up next, ${trackLabel}.`];
  }

  return candidates[
    Math.floor(Math.random() * candidates.length)
  ];
}


async function speakAutonomousDjIntro(
  guildId,
  track
) {
  const state =
    djStates.get(
      guildId
    );

  if (
    !state ||
    !state.current ||
    String(state.current.id) !==
      String(track?.id) ||
    !state.mixer ||
    state.mixer.destroyed ||
    state.autonomousIntroInFlight
  ) {
    return false;
  }

  state.autonomousIntroInFlight =
    true;

  let speechFile = null;

  try {
    const intro =
      buildAutonomousDjIntro(
        track,
        state.previousTrack,
        state.lastAutonomousIntroText,
        state.autonomousTracksSinceSpeech
      );

    if (!intro) {
      state.autonomousTracksSinceSpeech += 1;

      console.log(
        `FERGIE DJ AUTO INTRO SILENT 🤫 guild=${guildId} track=${track.id} silentRun=${state.autonomousTracksSinceSpeech}`
      );

      return true;
    }

    state.lastAutonomousIntroText = intro;
    state.autonomousTracksSinceSpeech = 0;

    console.log(
      `FERGIE DJ AUTO INTRO 🎙️ guild=${guildId} track=${track.id} text=${JSON.stringify(intro)}`
    );

    speechFile =
      await generateFergieSpeech(
        intro,
        `dj_${guildId}`
      );

    const mixed =
      await mixFergieSpeechIntoDj(
        guildId,
        speechFile
      );

    if (!mixed) {
      cleanupDjTempFile(
        speechFile
      );

      console.warn(
        `FERGIE DJ AUTO INTRO ⚪ track ended before intro guild=${guildId} track=${track.id}`
      );

      return false;
    }

    console.log(
      `FERGIE DJ AUTO INTRO COMPLETE ✅ guild=${guildId} track=${track.id}`
    );

    return true;
  } catch (error) {
    cleanupDjTempFile(
      speechFile
    );

    console.error(
      `FERGIE DJ AUTO INTRO ❌ guild=${guildId} track=${track?.id ?? "unknown"}`,
      error
    );

    // Intro failure must never stop or skip the music.
    return false;
  } finally {
    const latest =
      djStates.get(
        guildId
      );

    if (latest) {
      latest.autonomousIntroInFlight =
        false;
    }
  }
}

async function playNextDjTrack(guildId) {
  const state = getDjState(guildId);

  if (state.starting || state.current) {
    return false;
  }

  if (!state.queue.length) {
    console.log(`FERGIE DJ QUEUE EMPTY ✅ guild=${guildId}`);
    return false;
  }

  const connection = getVoiceConnection(guildId);

  if (!connection) {
    console.warn(`FERGIE DJ NEXT TRACK ⚪ no VC connection guild=${guildId}`);
    return false;
  }

  state.starting = true;
  const track = state.queue.shift();
  let trackFile = null;
  let mixer = null;
  let decoderProcess = null;

  try {
    trackFile = await fetchFergieDjTrackToTemp(track.id);

    mixer =
      new FergieDjMixer(
        guildId
      );

    decoderProcess =
      spawnDjMusicDecoder(
        trackFile,
        guildId
      );

    decoderProcess.stdout.pipe(
      mixer
    );

    const resource =
      createAudioResource(
        mixer,
        {
          inputType:
            StreamType.Raw,
        }
      );

    const subscription =
      connection.subscribe(
        state.player
      );

    if (!subscription) {
      throw new Error("Could not subscribe DJ player to voice connection");
    }

    if (state.subscription && state.subscription !== subscription) {
      try {
        state.subscription.unsubscribe();
      } catch {}
    }

    state.subscription = subscription;
    state.current = track;
    state.currentFile = trackFile;
    state.mixer = mixer;
    state.decoderProcess = decoderProcess;

    trackFile = null;
    mixer = null;
    decoderProcess = null;

    console.log(
      `FERGIE DJ START ▶️ guild=${guildId} track=${track.id} title=${JSON.stringify(formatDjTrack(track))} mixer=single-player`
    );

    state.player.play(resource);

    const shouldAutoIntro =
      String(
        state.pendingAutonomousIntroTrackId
      ) === String(
        track.id
      );

    if (shouldAutoIntro) {
      state.pendingAutonomousIntroTrackId =
        null;

      // Give the new music stream a moment to become active, then speak
      // through the proven H/7C single-player mixer. Never create a second
      // Discord audio subscription for autonomous DJ speech.
      setTimeout(() => {
        const latest =
          djStates.get(
            guildId
          );

        if (
          !latest ||
          !latest.current ||
          String(latest.current.id) !==
            String(track.id)
        ) {
          return;
        }

        speakAutonomousDjIntro(
          guildId,
          track
        ).catch((error) => {
          console.error(
            `FERGIE DJ AUTO INTRO TASK ❌ guild=${guildId} track=${track.id}`,
            error
          );
        });
      }, 900);
    }

    return true;
  } catch (error) {
    if (decoderProcess) {
      try {
        decoderProcess.kill("SIGKILL");
      } catch {}
    }

    if (mixer) {
      try {
        mixer.destroy();
      } catch {}
    }

    cleanupDjTempFile(trackFile);

    console.error(`FERGIE DJ START ❌ guild=${guildId} track=${track?.id ?? "unknown"}`, error);

    state.current = null;
    state.currentFile = null;
    state.mixer = null;
    state.decoderProcess = null;

    if (state.queue.length) {
      setImmediate(() => {
        playNextDjTrack(guildId).catch((nextError) => {
          console.error(`FERGIE DJ NEXT TRACK AFTER FAILURE ❌ guild=${guildId}`, nextError);
        });
      });
    }

    throw error;
  } finally {
    state.starting = false;
  }
}

function stopDjForGuild(guildId, removeState = false) {
  const state = djStates.get(guildId);

  if (!state) {
    return false;
  }

  const hadMusic = Boolean(state.current || state.queue.length || state.starting);

  state.queue.length = 0;
  state.pendingAutonomousIntroTrackId = null;
  state.previousTrack = null;
  state.lastAutonomousIntroText = null;
  state.autonomousTracksSinceSpeech = 0;
  state.recentAutonomousTrackIds = [];
  state.recentAutonomousArtists = [];
  state.intentionallyStopping = Boolean(state.current);

  let stopTriggeredIdle = false;

  if (state.player) {
    try {
      stopTriggeredIdle = state.player.stop(true);
    } catch {}
  }

  if (!stopTriggeredIdle) {
    state.intentionallyStopping = false;
  }

  cleanupDjTrackPipeline(
    state
  );

  state.current = null;
  state.starting = false;

  if (state.subscription) {
    try {
      state.subscription.unsubscribe();
    } catch {}

    state.subscription = null;
  }

  if (removeState) {
    djStates.delete(guildId);
  }

  console.log(`FERGIE DJ STOP ✅ guild=${guildId} clearQueue=true autonomousRestart=false`);
  return hadMusic;
}


// =========================
// SEARCH FERGIE DJ CRATE
// =========================
async function searchFergieDjCrate(query) {
  if (!FERGIE_DJ_URL) {
    throw new Error("FERGIE_DJ_URL is missing");
  }

  if (!FERGIE_DJ_API_KEY) {
    throw new Error("FERGIE_DJ_API_KEY is missing");
  }

  const cleanQuery = String(query || "").trim();

  if (!cleanQuery) {
    return [];
  }

  const response = await fetch(
    `${FERGIE_DJ_URL}/crate/search?q=${encodeURIComponent(cleanQuery)}`,
    {
      method: "GET",
      headers: {
        "X-Fergie-DJ-Key": FERGIE_DJ_API_KEY,
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Fergie DJ crate search failed: ${response.status} ${errorText}`
    );
  }

  const result = await response.json();

  if (!result?.ok || !Array.isArray(result.results)) {
    throw new Error(
      `Fergie DJ crate search returned an invalid response: ${JSON.stringify(result)}`
    );
  }

  return result.results;
}


// =========================
// FETCH FERGIE DJ TRACK FOR VC PLAYBACK
// =========================
async function fetchFergieDjTrackToTemp(trackId) {
  if (!FERGIE_DJ_URL) {
    throw new Error("FERGIE_DJ_URL is missing");
  }

  if (!FERGIE_DJ_API_KEY) {
    throw new Error("FERGIE_DJ_API_KEY is missing");
  }

  const response = await fetch(
    `${FERGIE_DJ_URL}/track/${trackId}`,
    {
      method: "GET",
      headers: {
        "X-Fergie-DJ-Key": FERGIE_DJ_API_KEY,
      },
      signal: AbortSignal.timeout(30000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Fergie DJ track fetch failed: ${response.status} ${errorText}`
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  if (audioBuffer.length < 1024) {
    throw new Error(
      `Fergie DJ track fetch returned too little audio: ${audioBuffer.length} bytes`
    );
  }

  const trackFile = `/tmp/fergie_dj_track_${trackId}_${Date.now()}.mp3`;
  fs.writeFileSync(trackFile, audioBuffer);

  console.log(
    `FERGIE DJ PLAYBACK FETCH ✅ track=${trackId} bytes=${audioBuffer.length}`
  );

  return trackFile;
}


// =========================
// DETECT FERGIE'S NAME
// =========================
function isFergieAddressed(
  transcript
) {
  return /\b(?:ferg(?:ie|i|y)?|berg(?:ie|y)|erg(?:ie|i))\b/i.test(
    transcript || ""
  );
}

// =========================
// DECIDE WHETHER FERGIE RESPONDS
// =========================
function shouldFergieRespond(
  guildId,
  transcript
) {
  const directlyAddressed =
    isFergieAddressed(
      transcript
    );

  if (directlyAddressed) {
    return {
      respond: true,
      reason:
        "directly addressed",
    };
  }

  const now =
    Date.now();

  const lastUnsolicitedAt =
    lastUnsolicitedReplyAtByGuild.get(
      guildId
    ) || 0;

  const elapsed =
    now -
    lastUnsolicitedAt;

  if (
    elapsed <
    UNSOLICITED_RESPONSE_COOLDOWN_MS
  ) {
    const secondsLeft =
      Math.ceil(
        (
          UNSOLICITED_RESPONSE_COOLDOWN_MS -
          elapsed
        ) /
          1000
      );

    return {
      respond: false,
      reason:
        `unsolicited cooldown active (${secondsLeft}s left)`,
    };
  }

  const roll =
    Math.random();

  const respond =
    roll <
    UNSOLICITED_RESPONSE_CHANCE;

  return {
    respond,

    reason:
      `unsolicited roll=${roll.toFixed(3)} ` +
      `chance=${UNSOLICITED_RESPONSE_CHANCE.toFixed(2)} ` +
      `=> ${respond ? "RESPOND" : "IGNORE"}`,
  };
}

// =========================
// DECIDE WHETHER FERGIE SPEAKS
// =========================
function shouldFergieSpeak(
  guildId,
  transcript
) {
  const directlyAddressed =
    isFergieAddressed(
      transcript
    );

  // Directly saying Fergie/Fergy ALWAYS
  // makes her speak and bypasses cooldown.
  if (directlyAddressed) {
    return {
      speak: true,
      reason:
        "directly addressed => SPEAK",
    };
  }

  const now =
    Date.now();

  const lastSpokeAt =
    lastVoiceReplyAtByGuild.get(
      guildId
    ) || 0;

  const elapsed =
    now -
    lastSpokeAt;

  if (
    elapsed <
    VOICE_COOLDOWN_MS
  ) {
    const secondsLeft =
      Math.ceil(
        (
          VOICE_COOLDOWN_MS -
          elapsed
        ) /
          1000
      );

    return {
      speak: false,
      reason:
        `cooldown active (${secondsLeft}s left)`,
    };
  }

  const roll =
    Math.random();

  const speak =
    roll <
    VOICE_CHANCE_NORMAL;

  return {
    speak,

    reason:
      `normal roll=${roll.toFixed(3)} ` +
      `chance=${VOICE_CHANCE_NORMAL.toFixed(2)} ` +
      `=> ${speak ? "SPEAK" : "TEXT ONLY"}`,
  };
}

// =========================
// ELEVENLABS TEXT-TO-SPEECH
// =========================
async function generateFergieSpeech(
  text,
  userId
) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is missing"
    );
  }

  if (!ELEVENLABS_VOICE_ID) {
    throw new Error(
      "ELEVENLABS_VOICE_ID is missing"
    );
  }

  // Keep normal Fergie on Flash v2.5.
  // Switch to Eleven v3 only for explicit whisper cues.
  const whisperPattern =
    /(?:\*+\s*whispers?\s*\*+|\(\s*whispers?\s*\)|\[\s*whispers?\s*\])/gi;

  const shouldWhisper =
    whisperPattern.test(text || "");

  whisperPattern.lastIndex = 0;

  const ttsText = shouldWhisper
    ? (text || "").replace(
        whisperPattern,
        "[whispers]"
      )
    : text;

  const ttsModel = shouldWhisper
    ? "eleven_v3"
    : "eleven_flash_v2_5";

  console.log(
    `FERGIE TTS MODE: ${shouldWhisper ? "WHISPER (v3)" : "NORMAL (flash v2.5)"}`
  );

  const response =
    await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
      {
        method:
          "POST",

        headers: {
          "xi-api-key":
            ELEVENLABS_API_KEY,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            text: ttsText,

            model_id:
              ttsModel,

            voice_settings: {
              stability:
                0.45,

              similarity_boost:
                0.8,

              style:
                0.25,

              use_speaker_boost:
                true,
            },
          }),
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `ElevenLabs TTS failed: ${response.status} ${errorText}`
    );
  }

  const audioBuffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!audioBuffer.length) {
    throw new Error(
      "ElevenLabs returned empty TTS audio"
    );
  }

  const speechFile =
    `/tmp/fergie_reply_${userId}_${Date.now()}.mp3`;

  fs.writeFileSync(
    speechFile,
    audioBuffer
  );

  console.log(
    `FERGIE TTS AUDIO: ${audioBuffer.length} bytes`
  );

  return speechFile;
}

// =========================
// PLAY FERGIE IN DISCORD VC
// =========================
async function playSpeechInVC(
  connection,
  speechFile
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const player =
        createAudioPlayer();

      const resource =
        createAudioResource(
          speechFile
        );

      const subscription =
        connection.subscribe(
          player
        );

      if (
        !subscription
      ) {
        reject(
          new Error(
            "Could not subscribe audio player to voice connection"
          )
        );
        return;
      }

      let finished =
        false;

      const cleanup =
        () => {
          if (
            finished
          ) {
            return;
          }

          finished =
            true;

          try {
            subscription.unsubscribe();
          } catch {}

          try {
            fs.unlinkSync(
              speechFile
            );
          } catch {}
        };

      player.once(
        AudioPlayerStatus.Playing,
        () => {
          console.log(
            "FERGIE IS SPEAKING 🔊"
          );
        }
      );

      player.once(
        AudioPlayerStatus.Idle,
        () => {
          cleanup();
          resolve();
        }
      );

      player.once(
        "error",
        (error) => {
          cleanup();
          reject(
            error
          );
        }
      );

      player.play(
        resource
      );
    }
  );
}

// =========================
// LOGIN
// =========================
client.login(TOKEN);
