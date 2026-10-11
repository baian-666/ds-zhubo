using System;
using System.Collections.Generic;
using System.Globalization;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// JSON lines connect this local Windows worker to its owning Node process.
// EOF releases the microphone. Prompt references isolate late playback events.
public static class CohostSpeech {
    static readonly object outputLock = new object();
    static readonly object promptLock = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static readonly Dictionary<Prompt, string> prompts = new Dictionary<Prompt, string>();
    static SpeechRecognitionEngine recognizer;
    static SpeechSynthesizer synth;
    static long utterance;
    static long levelAt;
    static volatile bool closing;

    static void Emit(object value) {
        lock (outputLock) {
            Console.WriteLine(json.Serialize(value));
            Console.Out.Flush();
        }
    }
    static string PromptId(Prompt prompt) {
        lock (promptLock) {
            string id;
            return prompts.TryGetValue(prompt, out id) ? id : null;
        }
    }
    public static void Run(string mode, string wavePath) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            RecognizerInfo selected = null;
            foreach (var item in SpeechRecognitionEngine.InstalledRecognizers())
                if (item.Culture.Name == "zh-CN") { selected = item; break; }
            synth = new SpeechSynthesizer();
            var voices = new List<string>();
            foreach (var voice in synth.GetInstalledVoices())
                if (voice.Enabled && voice.VoiceInfo.Culture.Name == "zh-CN") voices.Add(voice.VoiceInfo.Name);
            if (mode == "probe") {
                Emit(new { type = "capabilities", recognition = selected != null, voices = voices.ToArray() });
                return;
            }
            if (selected == null) throw new InvalidOperationException("No zh-CN recognition engine");
            if (voices.Count > 0) synth.SelectVoice(voices[0]);
            synth.Rate = 1;
            recognizer = new SpeechRecognitionEngine(selected);
            recognizer.LoadGrammar(new DictationGrammar());
            recognizer.EndSilenceTimeout = TimeSpan.FromMilliseconds(650);
            recognizer.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(1000);
            recognizer.BabbleTimeout = TimeSpan.FromSeconds(12);
            recognizer.SpeechDetected += (sender, e) => {
                Interlocked.Increment(ref utterance);
                Emit(new { type = "speech-start", utterance = utterance });
            };
            recognizer.SpeechHypothesized += (sender, e) => Emit(new { type = "partial", utterance = utterance, text = e.Result.Text });
            recognizer.SpeechRecognized += (sender, e) => Emit(new { type = "final", utterance = utterance, text = e.Result.Text, confidence = e.Result.Confidence });
            recognizer.SpeechRecognitionRejected += (sender, e) => Emit(new { type = "rejected", utterance = utterance });
            recognizer.AudioLevelUpdated += (sender, e) => {
                long now = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
                if (now - levelAt < 150) return;
                levelAt = now;
                Emit(new { type = "level", level = e.AudioLevel });
            };
            recognizer.RecognizeCompleted += (sender, e) => {
                if (!closing) Emit(new { type = e.Error == null ? "input-ended" : "error", code = "recognition-ended" });
            };
            synth.SpeakStarted += (sender, e) => Emit(new { type = "playback-start", id = PromptId(e.Prompt) });
            // Position is the start of the current word. It is a conservative completed prefix.
            synth.SpeakProgress += (sender, e) => Emit(new { type = "playback-progress", id = PromptId(e.Prompt), playedChars = e.CharacterPosition });
            synth.SpeakCompleted += (sender, e) => {
                Emit(new { type = e.Cancelled ? "playback-cancelled" : e.Error != null ? "playback-error" : "playback-end", id = PromptId(e.Prompt) });
                lock (promptLock) prompts.Remove(e.Prompt);
            };
            if (mode == "fixture") {
                synth.SetOutputToWaveFile(wavePath);
                synth.Speak("今天我们聊一聊直播间。小鲸鱼，你觉得这个故事怎么样？");
                synth.SetOutputToNull();
                recognizer.SetInputToWaveFile(wavePath);
            } else {
                synth.SetOutputToDefaultAudioDevice();
                recognizer.SetInputToDefaultAudioDevice();
            }
            recognizer.RecognizeAsync(RecognizeMode.Multiple);
            Emit(new { type = "ready", voice = synth.Voice.Name, input = mode == "fixture" ? "wave-file" : "default-microphone" });
            string line;
            while ((line = Console.ReadLine()) != null) {
                var command = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                var action = Convert.ToString(command["action"], CultureInfo.InvariantCulture);
                if (action == "stop") break;
                if (action == "cancel") synth.SpeakAsyncCancelAll();
                if (action == "speak") {
                    var text = Convert.ToString(command["text"], CultureInfo.InvariantCulture);
                    var id = Convert.ToString(command["id"], CultureInfo.InvariantCulture);
                    if (text.Length > 4000 || text.Length == 0) continue;
                    var prompt = new Prompt(text);
                    lock (promptLock) prompts[prompt] = id;
                    synth.SpeakAsync(prompt);
                }
            }
        } catch (Exception e) {
            Emit(new { type = "error", code = "windows-speech-unavailable", detail = e.GetType().Name });
        } finally {
            closing = true;
            if (synth != null) { synth.SpeakAsyncCancelAll(); synth.Dispose(); }
            if (recognizer != null) { recognizer.RecognizeAsyncCancel(); recognizer.Dispose(); }
        }
    }
}
