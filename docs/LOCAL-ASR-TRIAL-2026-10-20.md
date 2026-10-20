# 本地流式识别试用：2026-10-20

用户要求直接试用本地识别，能够接受同音错字，但不能明显丢失意思。本轮已接入正式设置并启用；这是可回退试用，不是“稳定两秒、附和零误停”验收。

## 已部署

- 识别：`local / sherpa-zipformer-zh`，独立 Python 进程、sherpa-onnx 1.13.8、中文流式 Zipformer int8、CPU 两线程。使用已有模型和项目隔离依赖，没有新增云端账号或声音。
- 保存前实际加载模型验证；开麦时启动，关麦/结束收音后释放。不可用或加载失败不会保存无效配置；云端回退需要手动选择，不会静默上传到备用 ASR。
- 后端 `339336 → 338596`；保留另一个对话刚部署的桌面 `20261020T121921713Z-1ac6e5fb`、桌面进程336808及最新持续观察逻辑，未重启桌面。实际构建含本地选择项和流式收音分支。
- 新增 `.env` 的非密钥配置 `LOCAL_ASR_PYTHON=D:/work/code/anaconda/python.exe`；移除此新增行后的文件指纹与更新前一致。300条聊天逐字段一致，声音、角色、推理服务、手册和桌面指纹一致。
- 备份：`data/session-backups/local-enable-1792499152552.sqlite`；[部署核验](../data/local-enable-deployment.json)。收尾关麦、主持off，没有替用户打开麦克风。
- 实际 Electron 设置页显示“当前生效: local · sherpa-zipformer-zh”，本地和原 Fun-ASR 均可选择；核验后返回聊天。[截图](../data/local-enable-desktop-settings.png)、[设置核验](../data/local-enable-desktop-settings.json)。

试用：桌面点“开始收音”。回退：停止收音 → 直播助播设置 → 语音识别 → 选择“Fun-ASR-Realtime · 边说边识别（百炼）” → 验证并保存 → 重新开始收音。原声音设置不需改动。

## 原音频实际结果

继续使用已有三个合成 WAV，真实浏览器文件麦克风、VAD、本地 ASR、DeepSeek、原 Qwen 云端声音、WebAudio 录音。没有注入预期转写或模拟讲话事件。本轮讲话期间首句准备关闭，与正式配置一致；原有段结束准备保留。

| 原音频 | 本轮结果 | 边界 |
| --- | --- | --- |
| 猫咪故事 `local-enable-story-2` | 最后声音结束→最终转写344ms；→实际回答首声2050ms；最终31字回答完整 | 单次，未稳定两秒；中途普通回答因继续讲话取消，没有完成的≤4字短回应 |
| 附和/接管 `local-enable-backchannel-1` | 3.73秒附和期间实际有输出；一次hold→play为58ms；接管hold 654ms，末声730ms，之后无复播 | 仍有附和误停，不算零误停通过 |
| 继续讲话 `local-enable-resume-1` | 原回答实际在播，继续讲话后hold 620ms，末声700ms，之后无复播 | 有效停声样本，不能代替长时间真人聊天 |

录音：[故事](../data/listening-audio-trial/local-enable-story-2-listen.wav)、[附和/接管](../data/listening-audio-trial/local-enable-backchannel-1-listen.wav)、[继续讲话](../data/listening-audio-trial/local-enable-resume-1-listen.wav)。裁剪只去掉外侧静音，保留内部输入/输出相对时序。波形汇总保存在同名前缀的 `-analysis.json`、`-opening-summary.json`，故事另有 `-latency.json`。

三组没有 ASR/模型/HTTP/页面错误。第一次 `local-enable-story-1` 错用普通浏览器加载 Electron 页面，缺少ipcRenderer，没有开始收音；完整失败保留，不计性能或准确度样本。

并发工作限制：故事开始时源码一致；附和测试期间另一个对话修改了 `participation-model.mjs` 并部署持续观察，正式会话也发生变化，因此附和记录的当前源码哈希比较与正式会话不变检查均为false。其余已记录识别/播放源文件一致；resume与收尾源码哈希一致、正式会话不变。测试请求只写隔离后端。这轮不是锁定全机活动、全套提示的严格性能A/B，不与早先启用首句准备的耗时混算。

## 准确度

[逐段原文及统计](../data/local-enable-accuracy.json)用原SSML文字只做事后对照，未交给识别器。忽略标点，所有同音字仍计错误：

| 样本 | 本地字符编辑错误/参考字数 | 字符错误率 |
| --- | --- | --- |
| 故事 | 10/195 | 5.13% |
| 附和/接管 | 4/91 | 4.40% |
| 继续讲话 | 6/125 | 4.80% |

同一故事WAV的已有云端记录 `asr-cloud-story-2` 为2/195（1.03%），音频SHA256一致；这是历史转写对照，不能当本轮同配置延迟对照。不能把本地结果写成准确度与云端相同。

本地常见“它→他”“旷工→矿工”“它抱→踏报”“我在听→我再听”；附和样本还漏掉“钻纸箱”的“纸”。三组故事主旨、请求继续说和“我还没说完／你先听我把这个故事讲完”的意图保留，原故事回答对应发工资问题。没有验证口音、噪声、人名、数字、外放回声或真实用户语音；还没有标点，可能影响句中短回应的机会识别。

## 实测资源

[采样记录](../data/local-enable-story-2-resources.json)：使用psutil每500ms采样实际ASR工作进程；当时构建、类型检查、lint均已结束。机器16逻辑核心，CPU百分比是整机口径，非单核口径：

- 收音工作进程160次采样：峰值RSS **127.98 MiB**，峰值private **119.66 MiB**。
- 样本均值 **1.99% CPU**，P95 **4.39%**，最高 **9.38%**；包含加载、讲话和静音，不能称为持续讲话均值。讲话中观察约3%左右，静音采样可降至0。
- 保存验证的另一个短进程只有2个采样点：峰值112.65 MiB、一个CPU区间9.28%，样本不足以评价启动分布。
- 这只统计识别工作进程，不是整个桌面或整套语音系统的占用。正式保存后保持关麦，2秒只读采样没有本地ASR进程：[释放核验](../data/local-enable-idle-resources.json)。

## 实现和检查

新增正式识别契约、持久配置验证、本地适配器选择、前端流式分支和中英文设置项。保存/切换失败保留原配置，关麦取消片段、过期收音批次不能复用，声音配置独立。

源码：[服务契约](../packages/cohost-contracts/services.ts)、[配置](../apps/cohost/module-settings.mjs)、[语音桥](../apps/cohost/airi-voice.mjs)、[进程适配](../apps/cohost/local-streaming-asr.mjs)、[解码](../scripts/local-streaming-asr.py)、[设置](../integrations/airi/cohost-services-settings.vue)、[收音](../integrations/airi/use-cohost-voice.ts)、[资源采样](../scripts/measure-local-asr.py)。AIRI修改保存在可重放的integrations，不只留在vendor。

- 最终 `npm run check`、`npm test` **530/530**通过，含并行对话新增的测试，不把全部增量归因于本轮。
- 相关Vitest **9/9**、AIRI类型 **55/55**、lint **0错误/689警告**；其中本轮设置段落增加4项换行风格警告，无类型或运行错误。最初直接运行pnpm时触发依赖布局检查失败，改用项目固定环境后通过，未升级或清空依赖。
- 桌面和网页构建通过；实际Electron设置核验通过；Python语法通过。没有更改附和许可、暂停门槛或短回应收尾规则。

后续先收集真人试聊，关注关键意思、数字/否定、开始收音耗时和长时间CPU。附和58ms误停、句中短回应不稳定及稳定两秒仍待解决；整段回答仍依赖DeepSeek和Qwen，本地识别不能消除它们的等待。安装与前轮失败见[本地ASR前轮报告](ASR-TAIL-2026-10-20.md)。
