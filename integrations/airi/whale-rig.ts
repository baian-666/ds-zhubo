/** Names from the installed whale rig. Values come from its loaded expression groups. */
export const nativeExpressions = [
  'love',
  '兔兔贴纸',
  '单边马尾',
  '双手比耶',
  '吐舌',
  '吐魂',
  '呆呆眼',
  '哭',
  '喵喵手~喵~动画',
  '圆眼镜',
  '墨镜',
  '头箍',
  '巴菲',
  '开心兴奋',
  '心跳',
  '悲伤',
  '情绪花花',
  '感叹号',
  '手机换色',
  '挤',
  '撤回',
  '方眼镜',
  '星星眼',
  '晕晕',
  '椭圆眼镜',
  '橡皮',
  '流汗',
  '深色桌布',
  '点菜按下',
  '爱心眼',
  '猫猫贴纸',
  '生气',
  '画笔',
  '脸红',
  '蛋包饭',
  '蝴蝶结贴纸',
  '调皮',
  '闭眼口水',
  '问号',
  '阴暗',
  '魔爪',
  '魔爪换色',
  '鲸鱼',
  '鲸鱼放桌上',
] as const
export type NativeExpression = typeof nativeExpressions[number]
export const expressionAliases = { smile: '开心兴奋', think: '问号', surprise: '感叹号', pout: '生气' } as const
export const faceExpressions = ['love', '吐舌', '吐魂', '呆呆眼', '哭', '开心兴奋', '心跳', '悲伤', '情绪花花', '感叹号', '星星眼', '晕晕', '流汗', '爱心眼', '生气', '脸红', '调皮', '闭眼口水', '问号', '阴暗', '墨镜']
export const handExpressions = ['双手比耶', '喵喵手~喵~动画', '蛋包饭', '画笔', '橡皮']
export const glassesExpressions = ['圆眼镜', '墨镜', '方眼镜', '椭圆眼镜']
export const stickerExpressions = ['兔兔贴纸', '猫猫贴纸', '蝴蝶结贴纸']

/** Normalized controls bound to measured Cubism ranges. Switches never cross-fade drawings. */
export const componentBindings = {
  orderBoard: { id: 'point', min: 0, max: 1, neutral: 1, switch: true, description: '点菜板/默认手，1显示，0隐藏；与比耶、猫爪、手机手互斥' },
  peace: { id: 'phone7', min: 0, max: 1, neutral: 0, switch: true, description: '双手比耶，0关1开' },
  catPaws: { id: 'maoshou', min: 0, max: 1, neutral: 0, switch: true, description: '猫爪手，0关1开' },
  phone: { id: 'phone', min: 0, max: 1, neutral: 0, switch: true, description: '手机手，0关1开' },
  orderX: { id: 'pointX', min: -30, max: 30, neutral: 0, switch: false, description: '点菜手左右，-1到1，常用小幅度' },
  orderY: { id: 'pointY', min: -30, max: 30, neutral: 0, switch: false, description: '点菜手上下，-1到1' },
  orderPress: { id: 'pointZ', min: 0, max: 1, neutral: 0, switch: false, description: '点菜手按下，0到1' },
  phoneOpen: { id: 'phone2', min: 0, max: 1, neutral: 0, switch: false, description: '手机开盖，0到1，先开启phone' },
  phoneFlash: { id: 'phone3', min: 0, max: 3, neutral: 0, switch: false, description: '手机闪光，0到1，先开启phone' },
  catLeft: { id: 'maoshou2', min: -1, max: 1, neutral: 0, switch: false, description: '左猫爪姿态，-1到1，先开启catPaws' },
  catRight: { id: 'maoshou5', min: -1, max: 1, neutral: 0, switch: false, description: '右猫爪姿态，-1到1，先开启catPaws' },
  whaleBuddy: { id: 'jingyu', min: 0, max: 1, neutral: 0, switch: true, description: '鲸鱼道具，0关1开' },
  whaleOnDesk: { id: 'fangzhuoshang', min: 0, max: 1, neutral: 0, switch: true, description: '鲸鱼放桌上，0关1开' },
  draw: { id: 'bi', min: 0, max: 1, neutral: 0, switch: true, description: '画笔，0关1开；与橡皮互斥' },
  erase: { id: 'pi', min: 0, max: 1, neutral: 0, switch: true, description: '橡皮，0关1开' },
  squeeze: { id: 'ji', min: 0, max: 1, neutral: 0, switch: false, description: '蛋包饭挤压，0到1，需蛋包饭可见' },
  tailBase: { id: 'Param_Angle_Rotation_1_B_tail3', min: -45, max: 45, neutral: 0, switch: false, description: '尾巴根部，-1到1，常用±0.2到0.4' },
  tailMid: { id: 'Param_Angle_Rotation_2_B_tail3', min: -45, max: 45, neutral: 0, switch: false, description: '尾巴中段，-1到1，可与根部错开形成摇尾' },
  tailTip: { id: 'Param_Angle_Rotation_3_B_tail3', min: -45, max: 45, neutral: 0, switch: false, description: '尾巴末段，-1到1' },
  hairTuft: { id: 'ParamHairFront11', min: -1, max: 1, neutral: 0, switch: false, description: '呆毛弯曲，-1到1' },
  hairTurn: { id: 'ParamHairFront13', min: -1, max: 1, neutral: 0, switch: false, description: '呆毛转动，-1到1' },
} as const
export type ComponentAxis = keyof typeof componentBindings
export type Components = Partial<Record<ComponentAxis, number>>
export const componentAxes = Object.keys(componentBindings) as ComponentAxis[]
export const handAxes: ComponentAxis[] = ['orderBoard', 'peace', 'catPaws', 'phone']

/** Rejects other rigs even when they share standard head/eye parameters. */
export function isWhaleRig(groups: Map<string, { parameters: { parameterId: string }[] }>): boolean {
  return [['问号', 'ParamCheek74'], ['开心兴奋', 'ParamCheek76'], ['双手比耶', 'phone7'], ['蛋包饭', 'danbaofan']]
    .every(([name, id]) => groups.get(name)?.parameters.some(parameter => parameter.parameterId === id))
}
