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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const VOICE_CHANCE_NORMAL = 0.05;
const VOICE_CHANCE_DIRECT = 0.10;
const VOICE_COOLDOWN_MS = 5 * 60 * 1000;

const lastVoiceReplyAtByGuild = new Map();
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
    .setName("jointest")
    .setDescription("Join your current voice channel"),

  new SlashCommandBuilder()
    .setName("recordtest")
    .setDescription("Record your voice for a few seconds"),

  new SlashCommandBuilder()
    .setName("leavetest")
    .setDescription("Leave the voice channel"),
].map((command) => command.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("FERGIE NODE VC TEST READY ✅");

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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!interaction.guild) {
    return;
  }

  // =========================
  // /jointest
  // =========================
  if (interaction.commandName === "jointest") {
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
  // /recordtest
  // =========================
  if (interaction.commandName === "recordtest") {
    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      await interaction.reply({
        content: "Use `/jointest` first.",
        ephemeral: true,
      });
      return;
    }

    const userId = interaction.user.id;

    await interaction.reply(
      "🔴 Recording started. Say one clear sentence, then stop talking."
    );

    console.log(`Starting recording for ${userId}`);

    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1200,
      },
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const pcmChunks = [];

    opusStream
      .pipe(decoder)

      .on("data", (chunk) => {
        pcmChunks.push(Buffer.from(chunk));
      })

      .on("error", (error) => {
        console.error("Decoder error:", error);
      })

      .on("end", async () => {
        const pcm = Buffer.concat(pcmChunks);

        console.log(
          `PCM CAPTURE COMPLETE: ${pcm.length} bytes`
        );

        if (!pcm.length) {
          await interaction.channel.send(
            "❌ No PCM audio captured."
          );
          return;
        }

        const wav = createWavBuffer(
          pcm,
          48000,
          2,
          16
        );

        const filename = `/tmp/vc_test_${userId}.wav`;

        fs.writeFileSync(filename, wav);

        console.log(
          `WAV CREATED: ${filename} | ${wav.length} bytes`
        );

        await interaction.channel.send({
          content: `🎙️ Recording for <@${userId}>`,
          files: [filename],
        });

        // =========================
        // ELEVENLABS TRANSCRIPTION
        // =========================
        try {
          const transcript =
            await transcribeWithElevenLabs(wav);

          if (!transcript) {
            console.log("TRANSCRIPT: empty");

            await interaction.channel.send(
              "📝 I didn't get a usable transcript."
            );

            return;
          }

          console.log(`TRANSCRIPT: ${transcript}`);

          await interaction.channel.send(
            `📝 **Heard:** ${transcript}`
          );

          // =========================
          // GEMINI RESPONSE
          // =========================
          try {
            const fergieReply =
              await askGemini(transcript);

            if (!fergieReply) {
              console.log("FERGIE REPLY: empty");

              await interaction.channel.send(
                "💬 Fergie had nothing to say. Tragic."
              );

              return;
            }

            console.log(
              `FERGIE REPLY: ${fergieReply}`
            );

            // TEXT ALWAYS STAYS
            await interaction.channel.send(
              `💬 **Fergie:** ${fergieReply}`
            );

            // =========================
            // DECIDE IF SHE SPEAKS
            // =========================
            const voiceDecision = shouldFergieSpeak(
              interaction.guild.id,
              transcript
            );

            console.log(
              `VOICE DECISION: ${voiceDecision.reason}`
            );

            if (voiceDecision.speak) {
              try {
                console.log(
                  "Generating Fergie voice..."
                );

                const speechFile =
                  await generateFergieSpeech(
                    fergieReply,
                    userId
                  );

                console.log(
                  `TTS CREATED: ${speechFile}`
                );

                await playSpeechInVC(
                  connection,
                  speechFile
                );

                lastVoiceReplyAtByGuild.set(
                  interaction.guild.id,
                  Date.now()
                );

                console.log(
                  "FERGIE VC PLAYBACK COMPLETE ✅"
                );
              } catch (error) {
                console.error(
                  "Fergie TTS/playback error:",
                  error
                );

                await interaction.channel.send(
                  "❌ Fergie voice playback failed. Check Railway logs."
                );
              }
            }
          } catch (error) {
            console.error(
              "Gemini reply error:",
              error
            );

            await interaction.channel.send(
              "❌ Gemini reply failed. Check Railway logs."
            );
          }
        } catch (error) {
          console.error(
            "ElevenLabs transcription error:",
            error
          );

          await interaction.channel.send(
            "❌ ElevenLabs transcription failed. Check Railway logs."
          );
        }
      });

    return;
  }

  // =========================
  // /leavetest
  // =========================
  if (interaction.commandName === "leavetest") {
    const connection = getVoiceConnection(
      interaction.guild.id
    );

    if (connection) {
  connection.destroy();
}

autoListenStates.delete(
  interaction.guild.id
);

lastVoiceReplyAtByGuild.delete(
  interaction.guild.id
);

console.log(
  `AUTO LISTEN STOPPED ✅ guild=${interaction.guild.id}`
);

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

  // Prevent duplicate listeners if /jointest is used again.
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

      // Ignore unknown users, bots and Fergie herself.
      if (
        !member ||
        member.user.bot ||
        userId === client.user.id
      ) {
        return;
      }

      // Don't start a second recorder for the same person
      // while their current utterance is still active.
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
              Buffer.concat(pcmChunks);

            console.log(
              `AUTO PCM COMPLETE ${member.user.tag}: ` +
              `${pcm.length} bytes`
            );

            // Ignore tiny noises / accidental packets.
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

              // Phase 1:
              // Fergie only responds automatically
              // if somebody actually says her name.
              const directlyAddressed =
                /\bferg(?:ie|y)\b/i.test(
                  transcript
                );

              if (!directlyAddressed) {
                console.log(
                  "AUTO RESPONSE: ignored — Fergie not addressed"
                );
                return;
              }

              console.log(
                "AUTO RESPONSE: Fergie was addressed ✅"
              );

              const fergieReply =
                await askGemini(
                  transcript
                );

              if (!fergieReply) {
                return;
              }

              console.log(
                `AUTO FERGIE REPLY: ${fergieReply}`
              );

              // Text remains the primary response.
              await textChannel.send(
                `💬 **Fergie:** ${fergieReply}`
              );

              // Existing 10% direct voice chance
              // + existing 5-minute voice cooldown.
              const voiceDecision =
                shouldFergieSpeak(
                  guildId,
                  transcript
                );

              console.log(
                `AUTO VOICE DECISION: ${voiceDecision.reason}`
              );

              if (!voiceDecision.speak) {
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
    channels * (bitsPerSample / 8);

  const byteRate =
    sampleRate * blockAlign;

  const dataSize =
    pcmBuffer.length;

  const buffer =
    Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);

  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);

  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  pcmBuffer.copy(buffer, 44);

  return buffer;
}

// =========================
// ELEVENLABS SPEECH-TO-TEXT
// =========================
async function transcribeWithElevenLabs(wavBuffer) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is missing"
    );
  }

  const form = new FormData();

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

  const response = await fetch(
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
// GEMINI / FERGIE RESPONSE
// =========================
async function askGemini(transcript) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is missing"
    );
  }

  const prompt = `
You are Fergie.

You are a bratty, dramatic, chronically caffeinated Discord qtpi.

Someone just spoke to you in a Discord voice channel and said:

"${transcript}"

Reply naturally as Fergie.

Rules:
- Answer what they said directly.
- Keep it conversational.
- Keep it short: 1-3 sentences.
- Be sarcastic and playful, but not genuinely mean.
- Do not mention transcription, speech-to-text, AI, prompts, or being a bot.
- Do not describe actions in brackets.
- Just say what Fergie would actually say out loud.
`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "x-goog-api-key":
          GEMINI_API_KEY,
      },

      body: JSON.stringify({
        contents: [
          {
            role: "user",

            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Gemini failed: ${response.status} ${errorText}`
    );
  }

  const result =
    await response.json();

  const reply =
    result
      ?.candidates?.[0]
      ?.content
      ?.parts
      ?.map(
        (part) =>
          part.text || ""
      )
      .join("")
      .trim() || "";

  return reply;
}

// =========================
// DECIDE WHETHER FERGIE SPEAKS
// =========================
function shouldFergieSpeak(guildId, transcript) {
  const now = Date.now();

  const lastSpokeAt =
    lastVoiceReplyAtByGuild.get(guildId) || 0;

  const elapsed =
    now - lastSpokeAt;

  if (elapsed < VOICE_COOLDOWN_MS) {
    const secondsLeft = Math.ceil(
      (VOICE_COOLDOWN_MS - elapsed) / 1000
    );

    return {
      speak: false,
      reason:
        `cooldown active (${secondsLeft}s left)`,
    };
  }

  const directlyAddressed =
    /\bferg(?:ie|y)\b/i.test(transcript);

  const chance =
    directlyAddressed
      ? VOICE_CHANCE_DIRECT
      : VOICE_CHANCE_NORMAL;

  const roll =
    Math.random();

  const speak =
    roll < chance;

  return {
    speak,

    reason:
      `${directlyAddressed ? "direct" : "normal"} ` +
      `roll=${roll.toFixed(3)} ` +
      `chance=${chance.toFixed(2)} ` +
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

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: "POST",

      headers: {
        "xi-api-key":
          ELEVENLABS_API_KEY,

        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        text: text,

        model_id:
          "eleven_flash_v2_5",

        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.25,
          use_speaker_boost: true,
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
    (resolve, reject) => {
      const player =
        createAudioPlayer();

      const resource =
        createAudioResource(
          speechFile
        );

      const subscription =
        connection.subscribe(player);

      if (!subscription) {
        reject(
          new Error(
            "Could not subscribe audio player to voice connection"
          )
        );
        return;
      }

      let finished = false;

      const cleanup = () => {
        if (finished) {
          return;
        }

        finished = true;

        try {
          subscription.unsubscribe();
        } catch {}

        try {
          fs.unlinkSync(speechFile);
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
          reject(error);
        }
      );

      player.play(resource);
    }
  );
}

// =========================
// LOGIN
// =========================
client.login(TOKEN);
