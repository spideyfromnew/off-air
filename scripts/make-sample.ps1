# Generates a fictional two-voice interview as per-line WAV files (16 kHz, 16-bit, mono)
# using Windows SAPI voices. Fully local - no external service, no downloads.
# Node script scripts/merge-wav.mjs then concatenates the lines into sample/interview-16k.wav.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$root   = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root ".tmp-sample"
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null

# Fictional interview about a municipal water contract. All names, companies and
# phone numbers are invented; any resemblance is coincidental.
$lines = @(
    @{ who = "interviewer"; text = "Off the record. This conversation never left this room, and nothing you say here is stored anywhere but this laptop. Ready?" },
    @{ who = "source";      text = "Ready. I have been a procurement officer at the city water department for eleven years. I can talk about the March contract." },
    @{ who = "interviewer"; text = "Tell me about the March contract for the pipe replacement." },
    @{ who = "source";      text = "The bid was supposed to be open. But an engineer named Daniel Kovac pushed the award to Meridian Pipeworks before the review board met." },
    @{ who = "interviewer"; text = "How do you know it was Kovac?" },
    @{ who = "source";      text = "I saw the email thread. He wrote, quote, we deliver this before the board session, unquote. The contract value was about four point two million." },
    @{ who = "interviewer"; text = "And Meridian Pipeworks, any link to the department?" },
    @{ who = "source";      text = "Kovac's brother-in-law runs their bidding desk. I will spell it for the record. K-o-v-a-c. That is all I will say about him." },
    @{ who = "interviewer"; text = "Where did you see the thread?" },
    @{ who = "source";      text = "In the shared procurement drive, folder slash tenders slash twenty twenty six dash zero three. I can describe it, but I will not forward files." },
    @{ who = "interviewer"; text = "If we publish, what happens to you?" },
    @{ who = "source";      text = "If my name appears anywhere, I lose my job and maybe worse. You can call me a city official familiar with the contract. Nothing else." },
    @{ who = "interviewer"; text = "Understood. One last thing. Can others confirm the amount?" },
    @{ who = "source";      text = "The board minutes from March fourteenth mention the figure. That document is public. Good luck, and thank you for not recording this in the cloud." }
)

# Pick installed voices that exist on every Windows box: Microsoft Zira (female)
# and Microsoft David (male). Fall back to the default voice if missing.
$voiceFemale = (New-Object System.Speech.Synthesis.SpeechSynthesizer)
$voiceMale   = (New-Object System.Speech.Synthesis.SpeechSynthesizer)

$femaleName = ($voiceFemale.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name } | Where-Object { $_ -match "Zira|Hazel|Susan" } | Select-Object -First 1)
$maleName   = ($voiceMale.GetInstalledVoices()   | ForEach-Object { $_.VoiceInfo.Name } | Where-Object { $_ -match "David|Mark|George" } | Select-Object -First 1)

if ($femaleName) { $voiceFemale.SelectVoice($femaleName) }
if ($maleName)   { $voiceMale.SelectVoice($maleName) }

$voiceFemale.Rate = -1
$voiceMale.Rate   = -1

$i = 0
foreach ($line in $lines) {
    $i++
    $synth = if ($line.who -eq "interviewer") { $voiceFemale } else { $voiceMale }
    $file  = Join-Path $outDir ("line-{0:d2}-{1}.wav" -f $i, $line.who)
    $fmt   = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($file, $fmt)
    $synth.Speak($line.text)
    $synth.SetOutputToNull()
    Write-Host "wrote $file"
}

$voiceFemale.Dispose()
$voiceMale.Dispose()
Write-Host "Sample lines generated: $i"
