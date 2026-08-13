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
} = require("@discordjs/voice");

const prism = require("prism-media");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const FERGIE_BRAIN_URL = (process.env.FERGIE_BRAIN_URL || "").replace(/\/$/, "");
const VC_BRIDGE_SECRET = process.env.VC_BRIDGE_SECRET;

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
].map((command) => command.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("FERGIE NODE VC TEST READY ✅");

  await checkFergieBrainHealth();

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
});

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

              try {
                console.log(
                  "AUTO generating Fergie voice..."
                );

                const speechFile =
                  await generateFergieSpeech(
                    fergieReply,
                    userId
                  );

                await playSpeechInVC(
                  connection,
                  speechFile
                );

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
// DETECT FERGIE'S NAME
// =========================
function isFergieAddressed(
  transcript
) {
  return /\b(?:ferg(?:ie|i|y)?|bergy)\b/i.test(
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
