// 서버(컨테이너 UTC)와 브라우저에서 같은 결과가 나오도록 시간대를 고정합니다.
const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function formatDateTime(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : '-'
}
