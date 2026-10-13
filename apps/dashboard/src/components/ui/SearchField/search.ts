// 주소 값(?q=)으로 서버가 조회하는 검색의 공통 규칙입니다(Package·Request). 서버·브라우저 모두에서 씁니다.

/** 입력을 멈춘 뒤 검색을 조회하기까지의 시간 */
export const SEARCH_DELAY_MS = 300

export const SEARCH_MAX_LENGTH = 100

export const normalizeSearch = (value: string) => value.trim().slice(0, SEARCH_MAX_LENGTH)
