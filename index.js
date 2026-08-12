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
} = require("@discordjs/voice");

const prism = require("prism-media");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

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

    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await interaction.reply(
      `Joined **${voiceChannel.name}** ✅`
    );

    return;
  }

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

    const opusStream = connection.receiver.subscribe(
      userId,
      {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1200,
        },
      }
    );

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

        try {
          const transcript = await transcribeWithElevenLabs(wav);

          if (transcript) {
            console.log(`TRANSCRIPT: ${transcript}`);

            await interaction.channel.send(
              `📝 **Heard:** ${transcript}`
            );
          } else {
            console.log("TRANSCRIPT: empty");

            await interaction.channel.send(
              "📝 I didn't get a usable transcript."
            );
          }
        } catch (error) {
          console.error("ElevenLabs transcription error:", error);

          await interaction.channel.send(
            "❌ ElevenLabs transcription failed. Check Railway logs."
          );
        }
      });

    return;
  }

  if (interaction.commandName === "leavetest") {
    const connection = getVoiceConnection(
      interaction.guild.id
    );

    if (connection) {
      connection.destroy();
    }

    await interaction.reply("Left VC.");

    return;
  }
});

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
  buffer.writeUInt32LE(
    36 + dataSize,
    4
  );
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
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
  buffer.write("data", 36);
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

async function transcribeWithElevenLabs(wavBuffer) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is missing");
  }

  const form = new FormData();

  form.append(
    "file",
    new Blob([wavBuffer], { type: "audio/wav" }),
    "fergie_vc_test.wav"
  );

  form.append("model_id", "scribe_v2");

  const response = await fetch(
    "https://api.elevenlabs.io/v1/speech-to-text",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: form,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `ElevenLabs STT failed: ${response.status} ${errorText}`
    );
  }

  const result = await response.json();

  return (result.text || "").trim();
}

client.login(TOKEN);
