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
export const handExpressions = ['双手比耶', '喵喵手~喵~动画', '蛋包饭']
export const glassesExpressions = ['圆眼镜', '墨镜', '方眼镜', '椭圆眼镜']
export const stickerExpressions = ['兔兔贴纸', '猫猫贴纸', '蝴蝶结贴纸']
export const drawingExpressions = ['画笔', '橡皮', '撤回']
export const whaleExpressions = ['鲸鱼', '鲸鱼放桌上']
export const expressionFamilies = [faceExpressions, handExpressions, glassesExpressions, stickerExpressions, drawingExpressions, whaleExpressions]

/** Unrelated props retain their own slot. Shared drawing families replace each other. */
export function expressionsConflict(first: string, second: string) {
  const resolve = (name: string) => Object.hasOwn(expressionAliases, name) ? expressionAliases[name as keyof typeof expressionAliases] : name
  const a = resolve(first)
  const b = resolve(second)
  return a === b || expressionFamilies.some(family => family.includes(a) && family.includes(b))
}

/** Normalized controls bound to measured Cubism ranges. Switches never cross-fade drawings. */
export const componentBindings = {
  orderBoard: { id: 'point', min: 0, max: 1, neutral: 1, switch: true, description: '点菜板/默认手，1显示，0隐藏；隐藏它不会自动拿出其他道具' },
  omelet: { id: 'danbaofan', min: 0, max: 1, neutral: 0, switch: true, description: '端出蛋包饭，1显示并收起其他手部道具，0收起；可同时选择脸部expression，挤酱另配squeeze' },
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
  whaleBuddy: { id: 'jingyu', min: 0, max: 1, neutral: 0, switch: true, description: '头顶小鲸鱼，0关1开；不是手持，与桌上鲸鱼互斥' },
  whaleOnDesk: { id: 'fangzhuoshang', min: 0, max: 1, neutral: 0, switch: true, description: '桌上小鲸鱼，0关1开，可独立显示，与头顶鲸鱼互斥' },
  draw: { id: 'bi', min: 0, max: 1, neutral: 0, switch: true, description: '桌面画笔按钮选中，0关1开；不是拿笔或真正画画，与橡皮/撤回互斥' },
  erase: { id: 'pi', min: 0, max: 1, neutral: 0, switch: true, description: '桌面橡皮按钮选中，0关1开；不实际擦除画面，与画笔/撤回互斥' },
  undo: { id: 'chehui', min: 0, max: 1, neutral: 0, switch: true, description: '桌面撤回按钮选中，0关1开；不撤销聊天或图画，与画笔/橡皮互斥' },
  beverage: { id: 'mozhua', min: 0, max: 1, neutral: 0, switch: true, description: '桌上魔爪饮料罐，0隐藏1显示；原生魔爪指饮料，不是爪子' },
  beverageColor: { id: 'mozhua2', min: 0, max: 1, neutral: 0, switch: true, description: '魔爪饮料换色，0原色1替代色；需beverage=1或命名表情魔爪可见' },
  phoneColor: { id: 'shouji', min: 0, max: 1, neutral: 0, switch: true, description: '手机换色，0原色1替代色；需phone=1，单独换色不会显示手机' },
  dessertHide: { id: 'baleite', min: 0, max: 1, neutral: 0, switch: true, description: '隐藏桌上巴菲甜点，1隐藏0显示；原生命名表情巴菲实际是隐藏，不是端出' },
  squeeze: { id: 'ji', min: 0, max: 1, neutral: 0, switch: false, description: '蛋包饭挤酱，0到1；先用omelet=1或命名表情蛋包饭端出，单独挤压不会显示饭' },
  tailBase: { id: 'Param_Angle_Rotation_1_B_tail3', min: -45, max: 45, neutral: 0, switch: false, description: '尾巴根部相对自然摆动的偏移，-1到1；轻微0.15到0.25，明确摇尾0.5到0.65，最后归0' },
  tailMid: { id: 'Param_Angle_Rotation_2_B_tail3', min: -45, max: 45, neutral: 0, switch: false, description: '尾巴中段相对自然摆动的偏移，-1到1；配合根部同向小幅0.15到0.25，避免等幅反向抵消' },
  tailTip: { id: 'Param_Angle_Rotation_3_B_tail3', min: -45, max: 45, neutral: 0, switch: false, description: '尾巴末段相对自然摆动的偏移，-1到1；通常同向0.05到0.15，最后归0' },
  hairTuft: { id: 'ParamHairFront11', min: -1, max: 1, neutral: 0, switch: false, description: '呆毛弯曲，-1到1' },
  hairTurn: { id: 'ParamHairFront13', min: -1, max: 1, neutral: 0, switch: false, description: '呆毛转动，-1到1' },
} as const
export type ComponentAxis = keyof typeof componentBindings
export type Components = Partial<Record<ComponentAxis, number>>
export const componentAxes = Object.keys(componentBindings) as ComponentAxis[]
export const handAxes: ComponentAxis[] = ['orderBoard', 'omelet', 'peace', 'catPaws', 'phone']
/** A named action and its component share one owner across sequence frames. */
export const expressionComponentAxes: Record<string, ComponentAxis> = {
  '双手比耶': 'peace',
  '喵喵手~喵~动画': 'catPaws',
  '蛋包饭': 'omelet',
  '画笔': 'draw',
  '橡皮': 'erase',
  '撤回': 'undo',
  '鲸鱼': 'whaleBuddy',
  '鲸鱼放桌上': 'whaleOnDesk',
  '魔爪': 'beverage',
  '魔爪换色': 'beverageColor',
  '手机换色': 'phoneColor',
  '巴菲': 'dessertHide',
  '挤': 'squeeze',
  '点菜按下': 'orderPress',
}
export const componentFamilies: { axes: ComponentAxis[], expressions: string[] }[] = [
  { axes: handAxes, expressions: handExpressions },
  { axes: ['draw', 'erase', 'undo'], expressions: drawingExpressions },
  { axes: ['whaleBuddy', 'whaleOnDesk'], expressions: whaleExpressions },
]

/** Rejects other rigs even when they share standard head/eye parameters. */
export function isWhaleRig(groups: Map<string, { parameters: { parameterId: string }[] }>): boolean {
  return [['问号', 'ParamCheek74'], ['开心兴奋', 'ParamCheek76'], ['双手比耶', 'phone7'], ['蛋包饭', 'danbaofan']]
    .every(([name, id]) => groups.get(name)?.parameters.some(parameter => parameter.parameterId === id))
}
