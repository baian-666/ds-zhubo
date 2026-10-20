# Amadeus / Aqua-TTS 对小鲸鱼的借鉴

核对日期：2026-10-12。范围为公开源码、作者测量记录及本项目代码对照；没有在本机运行第三方模型或复现延迟、试听音质。视频中的 α0.15 与本次仓库当前版本不是同一个快照。

固定研究版本：Amadeus `0dbf7efea7f735735a6316773f7f8e2d1d21aea0`；Aqua-TTS `591fbb5f82052b6965612a3f50dbc201fbc7e261`。Amadeus 原地址当前转向 Code-Amadeus/Amadeus。原始研究文件仅保存在忽略的 data/amadeus-research。

2026-10-13 补充核对当前 Aqua README：支持范围已包含 GPT-SoVITS v2/v2Pro/v2ProPlus/v3，v4 未支持；下文仅 V3 的限制描述属于上述固定研究快照。最新 README 明确历史 TTFP 是首块 PCM，不保证第一块含真实语音，并新增生成开头裁剪/onset 字段与 V2 系列独立基准。V3 的 0.4–0.7 秒作者播放链数字不应代替本机首个可听语音、中文质量或完整对话验收。本轮未更换已固定版本、安装或运行 Aqua；详见 STATUS 的加速核对。

## 判断

值得借鉴的是流式语音工程、播放同步和取消机制。公开代码能支持“做了实质优化”，不能支持“各部分都是最佳方案”或“所有对话稳定一秒内”。本项目继续保留 AIRI、DeepSeek 和直播导演，不整套迁移桌面 Agent。

## 延迟口径

- Aqua 是 GPT-SoVITS 的 GPU 推理优化层，并非新的音色模型。静态 KV 缓存、CUDA Graph 和可选 FlashAttention 等减少运行开销，音色和情绪仍取决于所选模型与参考材料。
- 作者 V3 暖缓存测试在 RTX 4070 Ti SUPER 16GB 上报告短/中/长文本首块 PCM 中位数约 233/288/348ms；包含播放器启动的 TTS 首音频通常为 0.4–0.7 秒。这些均不是从真人说完到 AI 开口的全对话延迟，首块 PCM 也未必包含可听语音。冷启动、设备和参考缓存会影响结果。
- Amadeus 10 月 7 日另一项 DeepSeek 文字路径测量，候选版本首 token 中位数 1.047 秒，且关闭 TTS。配置与视频不同，不能据此判视频虚假，但足以说明不能把“一秒内”推广到所有模型和路径。
- 本机已查为 RTX 4070 SUPER 12GB，非作者的显卡。尚无本机 Aqua 音质、首声或显存测试。

## 优先借鉴

1. **真正边合成边播放。** Amadeus 调度器保护首段及时送出，再根据播放余量安排后段；按话轮、语音代次及情绪隔离队列。我们目前直播 TTS 使用完整 WAV，服务端和 AIRI 适配器都等待 arrayBuffer，导演拟稿也等待完整结果。仅替换更快的 TTS，不能消除这些串行等待。应先记录各阶段耗时，再做本地流式 TTS 适配与增量播放器。不得在导演决定生效前播放未经确认的内容。
2. **一次决定同时驱动声音和表演。** Amadeus 实验情绪路由复用已有模型情绪标签，选择预热参考，不额外调用情绪模型；不同情绪边界不混合合成。其公开范围是 Windows CUDA、内嵌 V3、日语，默认关闭，不能认定中文已经验证。我们已有 AI 表演计划，但未传给 TTS，应复用它，而非再造一套情绪判断。
3. **提前识别，但确认说完后才提交。** 两阶段端点方案在短暂停顿时预先识别，继续说话就作废，真正结束才提交。可减少等待，不能把短停顿直接当交棒。我们当前云端识别若照搬可能增加重复请求和费用，排在语音输出试验之后。
4. **以实际播放为准。** Amadeus 在音频写入窗口推进嘴型，并隔离旧话轮的迟到任务。本项目已有播放后启动表演、取消和迟到保护，应保留并对流式音频补充验证。桌面助手的声音打断规则不可原样代替直播语义判断；主播“嗯、对”不应一律终止助播。

## 建议下一步（未实施）

- 以相同中文参考音色和台词，对照现有云端 TTS、GPT-SoVITS + Aqua，以及 IndexTTS 的情绪控制。先获得可用参考音频，不同时部署所有系统。
- 测平静、开心、吐槽、安慰四种表现，以及长句和中途打断；记录首个可听语音、完整合成耗时、连续请求稳定性和显存占用。音色像不像与情绪自然度由用户试听决定。
- 若 Aqua 中文音质及延迟合适，单独接入本地语音服务和流式播放，保留云端回退；将同次 AI 表演情绪传给声音。
- 后续再评估提前 ASR、多模态与更复杂工具。快速出声不等于会接梗、多方对话或主动参与，这些仍需真实直播话轮试验。

代码复用时检查许可证及外部资产条件：Amadeus 主仓库为 AGPL-3.0，Aqua 为 MIT；模型权重、参考录音和角色资源需要分别核对，不因源码公开而自动获得。

## Live2D 演出补充核对

公开主展示采用 SpriteForge 动画图与 KTX2/PixiJS，另有 Live2D 适配器及 VTube Studio 相关控制入口。不能把整套演示效果等同于可直接移植的 Live2D 动作库；角色资源也未随源码提供。

- `vts/expression_controller.py` 将模型解析的动作注册到 sentence_id，在实际该句开始播放时执行，再进入 speaking 状态。这比整个回答只启动一次动作更适合多句情绪变化。
- 同目录控制器有 EMO，以及 EXPR/PARAM/HOTKEY 的表现入口；本次读取的 `render/web/live2d_character.js` 主要将语义情绪通过 emotion_map 映射到已注册表情，并驱动平滑口型。不能据此宣称 AI 已自动发现任意模型组件、自由编排全身动作或逐帧生成动画。
- SpriteForge 的正常说完后停留与被打断立即释放有独立契约测试。思路可用于 Live2D：正常句尾保留一个收尾表情再回待机，明确打断立即停止嘴型和旧句动作。这是阅读源码/测试得到的机制证据，不是本机视觉复现。
- 语义意图在后台统一解析后再分发多个显示面，避免每个窗口各选不同的动画分支。它对 thinking 的随机分支并不等于更懂语境；不照搬到主播每次讲话的反应上。

本项目已开放 44 个原生项目及归一化组件序列，已有播放后启动、互斥图层、停留、取消与恢复。最有价值的新增方向是按语句绑定动作、正常句尾收尾、声音与面部共享情绪，以及保持跨句情绪连续性。跨句连续性是基于本项目需求提出的改进，不宣称 Amadeus 已实现所有细节。口型当前对照是音量包络驱动，不是已验证的音素口型。

例如“哼，才没有摸鱼。……不过这条弹幕确实好笑”：第一句轻微嘴硬、侧目，第二句再松开眉眼轻笑，句尾短暂保留笑意后回倾听；模型安排语义阶段，本地执行器负责平滑变化和参数互斥，无需模型逐帧计算或增加第二次动作推理。

参考：[表情生命周期](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/vts/expression_controller.py)、[Live2D 适配](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/render/web/live2d_character.js)、[句尾交接测试](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/tests/test_spriteforge_post_speech_handoff.py)。

## 主要依据

- [Amadeus](https://github.com/Code-Amadeus/Amadeus)
- [Aqua-TTS 说明、测量口径与支持范围](https://github.com/Lucas1479/Aqua-TTS/tree/591fbb5f82052b6965612a3f50dbc201fbc7e261)
- [情绪参考实验](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/docs/tts_emotion_references.md)
- [两阶段语音端点](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/docs/asr_speculative_endpointing.md)
- [文字路径延迟原始记录](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/docs/evidence/chat-runtime-corrected-default-latency-2026-10-07.json)
- [语音段调度](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/tts/utterance_scheduler.py)
- [实际播放](https://github.com/Code-Amadeus/Amadeus/blob/0dbf7efea7f735735a6316773f7f8e2d1d21aea0/tts/playback.py)

本轮仅调研与记录，未更改运行链路、凭据或模型，也未将作者测量记为本机验收。
