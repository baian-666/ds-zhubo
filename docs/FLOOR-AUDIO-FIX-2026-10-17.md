# 附和与接管协调修复

2026-10-17。对应[自然聊天计划](STREAMING-LISTENING.md#2026-10-17-自然聊天改进计划)第1、2批的首项实现。没有完成40例附和、30次配对时延、15分钟真人和外放回声验收，不宣称整体自然度或P95达标。

## 改动

- [共享话轮判据](../packages/cohost-contracts/floor.ts)取代普通回答原来的“持续640ms就取消”：明确附和继续；不确定先暂停当前音频；接管或暂停1800ms仍不能确认附和则取消。短反应仍在恢复讲话时立即让话。
- 临时转写的附和词未写完时，许可最多保持1200ms，新分句撤销旧许可。首个识别片段只有在一两个不确定字后出现独立附和分句时，允许一次最多400ms修正窗口；其他不明语音仍按640ms保护。这个窗口不是语义确认，最终文本不能继承它，更新不能无限延长。未知前缀接管若恰好含附和分句，仍可能多等最多400ms，这是待扩充音频覆盖的取舍。
- [参与判断](../apps/cohost/participation.mjs)在普通回答期间接收临时转写，使用同一任务通道判断backchannel/takeover/uncertain，间隔至少800ms、超时1600ms。必须匹配目标输出、输入段、导演修订和最新原文；过期结果丢弃。普通首句前没有串联额外模型请求。
- 导演获得已确认送达的句段、当前音频段/暂停偏移和未播计划。偏移是PCM片段位置，不是字词对齐，不推断准确已听前缀。未播内容不计入已交付记忆。
- [播放器](../integrations/airi/pausable-audio.ts)只暂停当前音源，不暂停麦克风AudioContext；恢复沿用原缓冲区偏移，动作/口型时钟随音频暂停。后续片段在暂停期间不能开播；取消后迟到模型、合成或音频不能恢复旧回答。
- [媒体桥](../integrations/airi/use-cohost-voice.ts)回传话轮状态；后端核对舞台所有权、收音版本、输入与输出编号。长附和最终转写和“第一段合成晚到、此时正在附和”的情况不再取消当前回答。主持closing、明确yieldToHost、静音和角色切换继续沿用原约束。
- 复现覆盖源位于integrations、packages和[补丁脚本](../scripts/patch-media.mjs)，不是仅改忽略的vendor。当前长附和效果依赖Fun-ASR增量转写，SenseVoice整段上传不具备同等及时语义证据。

## 真实音频方法与失败记录

[回放脚本](../scripts/listening-audio-trial.mjs)把同一WAV送进浏览器麦克风，实际运行VAD、Fun-ASR、DeepSeek、当前Qwen克隆音色及WebAudio。没有注入转写、接话事件或生成回复。隔离内存后端只读取当前用户音色/角色；原会话不用于试验。

左声道为输入，右声道为实际渲染的输出PCM，10ms窗RMS阈值0.004、间隙合并120ms。它能测软件音频停声，不能证明物理扬声器延迟、真人听感或外放回声鲁棒性。暂停控制日志必须与波形共同核对，短暂停可能被波形合并。

复用未重新生成的`input.wav`（69.852375s）和`resume-input.wav`（52.115875s）。另固定`backchannel-8000-input.wav`（57.27s）：邀请讲猫钻纸箱→8秒留白→“嗯，对对对，你继续说，我在听”→8秒留白→“不过我还没说完呢，你先听我把这个故事讲完……”→尾部留白。Huihui合成输入，不冒称真人。`ordinary-only`诊断关闭中途短反应候选以确保测试普通长回答，ASR/模型/TTS/播放器仍真实。

所有结果位于`data/listening-audio-trial/`，原始JSON、音频JSON、分析和双声道WAV均保留。

| 记录前缀 | 模式与结果 |
| --- | --- |
| floor-base-story-1 | 服务配置502，没有有效音频；失败保留 |
| floor-base-story-2 | 改前普通故事模式，中途短反应完整，最终回答等待4.72s |
| floor-base-ordinary-1 | 改前同resume音频，普通回答恢复讲话后约720ms停声 |
| floor-base-backchannel-1 | 早期夹具因PowerShell编码乱码，无效基线；不纳入行为结论 |
| floor-base-backchannel-2 | 夹具生成失败后中止，未作为有效成绩 |
| floor-old-player-backchannel-1 | 旧播放器/部分新后端、4.5秒间隔：首音频晚于附和，started被拒绝，无有效输出；用于复现首声准入问题 |
| floor-fix-backchannel-1 | 同8秒间隔夹具，附和未取消，但误暂停约408ms；接管约740ms停声，判附和失败 |
| floor-fix-backchannel-2 | 附和误暂停约127ms，接管约750ms；不能只看波形连续就判通过 |
| floor-final-backchannel | 第一版200ms修正窗口仍误暂停约121ms，接管约750ms；保留失败，随后收窄条件并调整窗口 |
| floor-final-resume | 同resume普通回答诊断，接管从63730ms到最后音频64450ms，约720ms；原会话未变 |
| floor-final-story | 同原故事普通模式，两次中途短反应；第一处恢复讲话33220ms、停声33290ms，约70ms。第二处声音在下一句之前结束但回执仍被取消，不能算两条均完整交付。完整回答首声81370ms、输入末尾70390ms，等待约10.98s，尚未优化 |
| floor-final2-backchannel | 最终400ms条件窗口版本，同8秒间隔夹具：附和37760–41490ms期间无hold/yield，同一回答继续。接管50430ms、最后音频51220ms，约790ms；51145ms本地hold，52949ms彻底yield，无复播。收音正常、原会话未变 |

可见6121后台WebSocket拒绝连接日志；有效录音的收音/识别传输状态正常，未把这些日志删除。早期SAPI默认音色缺失、UTF-8解码错误、播放器测试未解锁AudioContext以及检查失败均保留在data日志，不计为成功音频。

## 当前验收范围

最终附和夹具SHA-256：`2496f0fdb1c6640e6508a23aab88b008d564e8cfd2bd9c0dba5dfadfd164a0d7`。成功样本只有1轮最终候选，不能据此宣称误停率或P95目标通过。之前两轮原音频复测与最终版差异仅为附和识别修正窗口，已经分别标明记录名称，不伪装成全部同一源码指纹。

[21秒录音片段](../data/listening-audio-trial/floor-ack-takeover-clip.wav)从最终双声道录音34–55秒直接截取：先听她讲，左侧输入长附和，随后真正接管，右侧输出停止。没有拼接、去掉失败或重新合成输出。

`npm run check`、388项Node通过；AIRI根类型检查55/55、相关3文件10项Vitest通过；播放器真实AudioContext浏览器测试1项通过，验证暂停不挂起收音上下文、恢复不回到开头、取消不复活。这些确定性检查独立于上面的音频结果。

AIRI全仓lint最终0错误/683原有警告；固定桌面构建通过。验证日志：`data/floor-check-final.log`、`floor-test-final.log`、`floor-typecheck-final2.log`、`floor-vitest-final.log`、`floor-audio-browser-test-2.log`、`floor-lint-release.log`、`floor-desktop-build.log`。中途lint失败修复后重跑，未隐藏失败记录。

后续仍需不同表达、否定/引用叫停、连续30秒以上无停顿、笑声、真人耳机/外放等覆盖。识别空窗可能让附和短暂停；不能以短暂停可恢复代替“附和不停”的验收。完整回答等待此次没有解决，原故事的一次复测达到约10.98秒，应作为下一批延迟定位证据。

## 部署

空闲且关麦时备份`data/session-backups/floor-1792218354129.sqlite`，部署后端PID236512、固定桌面`20261017T062413829Z-6b3ed475`，桌面服务PID235476。舞台ready，收音关闭，自主主持off。

部署前后300条聊天的id/角色/正文/状态/来源/时间、角色目录、有效音色、服务配置及.env指纹一致；证据`data/floor-deployment-before.json`、`data/floor-deployment.json`。运行期编号和模式恢复遵循原会话规则。未清空或覆盖数据库，临时测试网页已关闭。后端与前端新增floorReview契约须一起更新/回退；旧桌面产物`20261017T033852433Z-923c246c`仅作为构建回退点，不自动回退后端源码或运行库。
