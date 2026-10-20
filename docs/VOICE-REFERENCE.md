# 小鲸鱼参考音频处理

更新：2026-10-13。用户指定 IndexTTS 音色克隆，提供带伴奏的歌曲素材。当前已完成本机人声分离及完整参考的克隆讲话小样，尚未切换助播声音。

## IndexTTS 完整参考试听

用户要求先用完整片段试听，因此使用 mvsep-candidate/full-reference.wav 全部 10 秒，保留用户指出的短和声；未使用下面 6.5 秒裁剪版，也没有微调训练。

最终目录 `data/voice-reference/song-20261013/indextts-full-final`：

- `plain.wav`：“晚上好，我是小鲸鱼。今天不唱歌了，我们来聊聊天。你说，我在听。”约 7.99 秒。
- `happy.wav`：“你来啦！我刚才还在等你呢，今天有什么好玩的事情？”约 6.78 秒，明确 happy 向量 0.35；不调用额外文字情绪模型。
- `report.json`：实际来源、全长参考、配置、耗时和音频哈希。

两条均为 22050Hz 单声道 PCM16；声码器浮点输出保存前预留约 0.9 峰值，最终没有近满幅采样。这是音量余量处理，不是音色修复、去和声或音质验收。初始全 GPU 显存接近满载，未完成结果；采用 CPU 参考编码器、GPU 语音生成与缓存清理后实际成功。脚本保护已有输出，全部处理本机完成。

环境在忽略 data/indextts：Python3.11.17、uv0.13.0、官方 uv.lock 基础依赖、torch2.8.0+cu128；未安装 WebUI、DeepSpeed、额外 Qwen 情绪分析或修改系统 Python。源码固定 d9e41aac89fd00b3d71497fddb287b7f24613712。必要模型从官方指定仓库按固定版本下载并核对 LFS SHA256：

| 仓库 | 固定 revision |
| --- | --- |
| IndexTeam/IndexTTS-2.5 | c39ce5ba981572cb187443877ff559dfb246ce63 |
| facebook/w2v-bert-2.0 | da985ba0987f70aaeb84a80f2851cfac8c697a7b |
| nvidia/bigvgan_v2_22khz_80band_256x | 633ff708ed5b74903e86ff1298cf4a98e921c513 |
| funasr/campplus | e4b6ede7ce16997aff4ae69fbca1f0175e2afede |

文件记录在 data/indextts/model-files.json。未下载可选 Qwen 权重、重复 w2v 检查点或声码器训练优化器。上游 IndexTTS 源码未改；资源策略与音量处理位于受跟踪的试听脚本。

复用已经准备好的环境生成新的结果目录：

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONUNBUFFERED='1'
& 'D:/ds-zhubo/data/indextts/repo/.venv/Scripts/python.exe' scripts/indextts-audition.py `
  --reference data/voice-reference/song-20261013/mvsep-candidate/full-reference.wav `
  --output data/voice-reference/song-20261013/indextts-full-replay `
  --reference-encoder-device cpu
```

最终首次完整合成约 22.82 秒（含参考处理），复用参考约 8.27 秒，均是非流式整文件时间。不能据此宣称直播低延迟完成；目前未接 cohost/AIRI，也未切换正式声音。音色是否像、是否带歌唱腔/金属声与情绪是否自然，需用户试听。

## 用户网站分离版候选

用户随后自行用 MVSEP 分离并提供 `C:/Users/amber/Downloads/preview-08-18_bs6stem_mt_0_vocals.mp3`，约 10 秒、44.1kHz 双声道 MP3；指出该文件第 7–8 秒有短和声。已按用户标注取连续 0–6.5 秒，避开所述区域并保留 0.5 秒余量，末尾仅做 30ms 淡出，转 24kHz 单声道 PCM16。未剪中间再拼接、变调或再分离。

新候选为 `data/voice-reference/song-20261013/mvsep-candidate/reference-no-marked-harmony.wav`，同时保存完整 10 秒转换版 `full-reference.wav` 与来源哈希/检查 `report.json`。两者容器、采样格式和无近削波检查通过。依据用户时间点裁剪，不宣称已听到剩余段无和声、边界恰好在完整歌词末尾或音色克隆一定成功；用户随后选择先用完整 10 秒生成，上方结果即该选择。用户原下载文件未改。

## 当前本机结果

素材：`D:/edge_download/音鲸干活唱歌1分钟纯享版_音频.mp3`，约 60.256 秒。文件实际为 MP4/M4A 容器内 AAC，原文件保持不变。转换为 WAV 不能恢复原始压缩损失。

生成文件均在忽略目录 `data/voice-reference/song-20261013/separated-mdx`：

- `vocals.wav`：完整分离人声，44.1kHz 双声道 PCM16。
- `accompaniment.wav`：原混音减人声的伴奏对照，同样长度与采样格式。
- `vocals-reference-24k.wav`：完整人声的 24kHz 单声道 PCM16，供后续选取克隆参考。
- `preview-08-18.wav`、`preview-32-42.wav`：两个固定 10 秒人声试听，边缘各 50ms 淡入淡出；不是根据听感选出的最佳片段。
- `report.json`、`validation.json`：模型/输入指纹、计算参数、运行时间、样本检查和原文件完整性。

使用 UVR 公共 `UVR-MDX-NET-Voc_FT.onnx`，官方模型数据尾段 MD5 匹配 `77d07b2667ddf05b9e3175941b4454a0`，全模型 SHA256 `534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111`。3072 频率维、256 时间帧、FFT 7680、hop 1024、补偿 1.021；25% 分块重叠及正/负极性平均。只做分离，没有额外强力降噪、去混响、修音、变调或训练。

Python/NumPy/SciPy 复用本机已有环境，ONNX Runtime 1.23.2 和 flatbuffers 安装在项目忽略的 data/audio-toolchain/onnx，系统环境未修改。模型约 64MB，CPU 分离约 60.6 秒；这是离线素材处理耗时，不是助播语音首声延迟。音频未上传外部服务。

## 检查与限制

频谱转换的随机双声道往返最大误差约 5.96e-8；分离输出有限、可正常读写，实际各 WAV 长度、格式与近削波检查通过；原文件哈希未变化。人声和残差相加数值一致仅是算术检查，不能证明人声干净或分离质量。

当前工具不支持让模型直接听到音频；尚未听感验收，不能宣称没有伴奏残留、混响、和声或金属感。用户试听后再选参考片段，单人、接近说话、少拖音者优先。歌曲参考能否产生自然讲话与目标音色相似度，需实际 IndexTTS 小样评估。

## 复现

依赖与模型均在本机忽略目录。生成新目录，拒绝覆盖既有结果：

```powershell
& 'D:/work/code/anaconda/python.exe' scripts/separate-reference.py `
  --input data/voice-reference/song-20261013/source-stereo-for-separation.wav `
  --output data/voice-reference/song-20261013/separated-mdx-replay
```

处理脚本不包含网络请求，只读本机输入，输出限定项目 data 内。源音频、模型与分离资产不提交。

来源：[UVR 项目](https://github.com/Anjok07/ultimatevocalremovergui)、[模型发布](https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models)。后续正式 TTS 部署另行记录，不能把本次素材处理当作克隆成功。
