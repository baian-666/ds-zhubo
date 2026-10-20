const localTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})

// A fresh clock accompanies each decision; the scheduler owns the time between calls.
export function liveClock(now=Date.now()) {
  return {nowMs:now,iso:new Date(now).toISOString(),localTime:localTime.format(now),timeZone:'Asia/Shanghai'}
}
