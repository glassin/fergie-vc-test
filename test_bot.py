import os
import io
import discord

TOKEN = os.getenv("DISCORD_TOKEN")

bot = discord.Bot()


@bot.event
async def on_ready():
    print(f"Logged in as {bot.user}")
    print("FERGIE VC TEST READY ✅")


@bot.slash_command(
    name="jointest",
    description="Join your current VC for the recording test"
)
async def jointest(ctx: discord.ApplicationContext):

    if not ctx.author.voice or not ctx.author.voice.channel:
        await ctx.respond(
            "Join a voice channel first.",
            ephemeral=True
        )
        return

    channel = ctx.author.voice.channel

    if ctx.voice_client:
        await ctx.voice_client.move_to(channel)
    else:
        await channel.connect()

    await ctx.respond(
        f"Joined **{channel.name}** ✅"
    )


async def finished_callback(
    sink: discord.sinks.WaveSink,
    channel: discord.TextChannel
):

    print("RECORDING FINISHED")

    if not sink.audio_data:
        await channel.send(
            "❌ No audio was captured."
        )
        return

    await channel.send(
        f"✅ Captured audio from {len(sink.audio_data)} user(s)."
    )

    for user_id, audio in sink.audio_data.items():

        audio.file.seek(0)
        wav_bytes = audio.file.read()

        print(
            f"USER {user_id}: "
            f"{len(wav_bytes)} WAV bytes"
        )

        if not wav_bytes:
            continue

        discord_file = discord.File(
            io.BytesIO(wav_bytes),
            filename=f"vc_test_{user_id}.wav"
        )

        await channel.send(
            f"🎙️ Recording for <@{user_id}>",
            file=discord_file
        )


@bot.slash_command(
    name="recordtest",
    description="Start the VC recording test"
)
async def recordtest(ctx: discord.ApplicationContext):

    voice_client = ctx.voice_client

    if not voice_client or not voice_client.is_connected():
        await ctx.respond(
            "Use `/jointest` first.",
            ephemeral=True
        )
        return

    if voice_client.recording:
        await ctx.respond(
            "Already recording.",
            ephemeral=True
        )
        return

    sink = discord.sinks.WaveSink()

    voice_client.start_recording(
        sink,
        finished_callback,
        ctx.channel
    )

    await ctx.respond(
        "🔴 Recording started. Talk normally for about 5 seconds, then use `/stoptest`."
    )


@bot.slash_command(
    name="stoptest",
    description="Stop the VC recording test"
)
async def stoptest(ctx: discord.ApplicationContext):

    voice_client = ctx.voice_client

    if not voice_client or not voice_client.is_connected():
        await ctx.respond(
            "I'm not in VC.",
            ephemeral=True
        )
        return

    if not voice_client.recording:
        await ctx.respond(
            "I'm not recording.",
            ephemeral=True
        )
        return

    voice_client.stop_recording()

    await ctx.respond(
        "⏹️ Recording stopped. Processing WAV..."
    )


@bot.slash_command(
    name="leavetest",
    description="Leave VC"
)
async def leavetest(ctx: discord.ApplicationContext):

    if ctx.voice_client:
        await ctx.voice_client.disconnect()

    await ctx.respond(
        "Left VC."
    )


if not TOKEN:
    raise RuntimeError(
        "DISCORD_TOKEN environment variable is missing"
    )

bot.run(TOKEN)
