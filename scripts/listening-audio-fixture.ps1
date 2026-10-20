param([switch]$ResumeProbe, [switch]$BackchannelProbe, [string]$VoiceName = 'Microsoft Kangkang', [int]$BackchannelGapMs = 4500)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$directory = Join-Path $PSScriptRoot '../data/listening-audio-trial'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $speaker.SelectVoice($VoiceName)
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $name = if ($BackchannelProbe) { 'backchannel-' + $BackchannelGapMs + '-input' } elseif ($ResumeProbe) { 'resume-input' } else { 'input' }
  $speaker.SetOutputToWaveFile((Join-Path $directory ($name + '.wav')), $format)
  $ssml = @'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">
<break time="2500ms"/>
小鲸鱼，我今天发现一个特别好笑的事情。我家猫居然坐着扫地机器人在客厅巡逻，它还一脸严肃，像是在检查员工有没有偷懒。你说它是不是把自己当成老板了？
<break time="450ms"/>
我本来想把它抱下来，结果它还不乐意，一直盯着我看，好像我才是那个旷工的人。
<break time="500ms"/>
不过你先听我说，后面还有更离谱的。扫地机器人卡在地毯上，它就坐在那儿等着我过去推，连一步路都不肯自己走。
<break time="450ms"/>
后来我干脆给它拍了张照片，发到群里，大家都说这是老板在体验基层生活。小鲸鱼，你觉得这个老板该不该给我发工资？
<break time="16000ms"/>
</speak>
'@
  if ($ResumeProbe) {
    $ssml = @'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">
<break time="2500ms"/>
小鲸鱼，我家的猫坐着扫地机器人巡逻，像个老板一样。你觉得它会给我发工资吗？你说说看。
<break time="4500ms"/>
不过我还没说完呢，后面还有一件事。它今天把我的键盘当成了枕头，我一碰键盘它就伸爪子拦着我，好像这个电脑也是它的一样。我本来想把工作做完再陪它玩，它却直接躺在了屏幕前面。你先听我把这个故事讲完。
<break time="12000ms"/>
</speak>
'@
  }
  if ($BackchannelProbe) {
    $ssml = @'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">
<break time="2500ms"/>
小鲸鱼，我想听你讲讲猫为什么喜欢钻纸箱，你展开讲两个具体的例子，讲完整一点，你来说说。
<break time="4500ms"/>
嗯，对对对，你继续说，我在听。
<break time="4500ms"/>
不过我还没说完呢，你先听我把这个故事讲完，我家的猫昨天把纸箱当成了自己的城堡，谁也不让靠近。
<break time="12000ms"/>
</speak>
'@
  }
  if ($BackchannelProbe) { $ssml = $ssml.Replace('<break time="4500ms"/>', ('<break time="' + $BackchannelGapMs + 'ms"/>')) }
  $ssml | Set-Content -Encoding utf8 (Join-Path $directory ($name + '.ssml'))
  $speaker.SpeakSsml($ssml)
} finally { $speaker.Dispose() }
