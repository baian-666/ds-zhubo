/** Parameter groups controlled by an explicit pose. Mouth opening belongs to speech during playback. */
export const poseParameters = {
  eyeX: ['ParamEyeBallX'],
  eyeY: ['ParamEyeBallY'],
  eyeSquint: ['ParamEyeLOpen', 'ParamEyeROpen'],
  headX: ['ParamAngleX'],
  headY: ['ParamAngleY'],
  headZ: ['ParamAngleZ'],
  bodyX: ['ParamBodyAngleX'],
  bodyY: ['ParamBodyAngleY'],
  bodyZ: ['ParamBodyAngleZ'],
  mouthForm: ['ParamMouthForm'],
  mouthOpen: ['ParamMouthOpenY'],
} as const

type Axis = keyof typeof poseParameters

/** One small nod returns to neutral in 1.1 seconds, including during long speech. */
export function sampleNod(elapsedMs: number) {
  const progress = Math.max(0, Math.min(1, elapsedMs / 1100))
  if (progress === 0 || progress === 1)
    return 0
  return -0.16 * Math.sin(Math.PI * progress) ** 2
}

interface Core {
  getParameterValueById: (id: string) => number
  setParameterValueById: (id: string, value: number) => void
}

/** Omitted axes give the native joystick full control. An explicit mask leaves other animation layers intact. */
export function applyPoseParameters(core: Core, pose: Record<Axis, number>, axes?: readonly string[]) {
  for (const axis of Object.keys(poseParameters) as Axis[]) {
    if (axes && !axes.includes(axis))
      continue
    const value = pose[axis]
    for (const id of poseParameters[axis]) {
      if (axis === 'eyeSquint')
        core.setParameterValueById(id, core.getParameterValueById(id) * (1 - value))
      else
        core.setParameterValueById(id, value * (axis.startsWith('head') ? 30 : axis.startsWith('body') ? 10 : 1))
    }
  }
}
