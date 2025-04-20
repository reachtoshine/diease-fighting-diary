const searchInput = document.getElementById("searchInput");
const results = document.getElementById("results");
const popup = document.getElementById("popup");
let first = null;

let searchMode = null;

// 팝업 열기
if (first === null) {
  searchInput.addEventListener("click", () => {
    popup.classList.remove("hidden");
    first = true
  });
}

// 팝업 닫기
function closePopup() {
  popup.classList.add("hidden");
}

// 검색 방식 설정
function setSearchMode(mode) {
  searchMode = mode;
  closePopup();
  searchInput.removeAttribute("readonly");
  searchInput.value = "";
  searchInput.placeholder = mode === 'name' ? "병명을 입력하세요..." : "질병코드를 입력하세요...";
  searchInput.focus();
}

// 입력 이벤트
searchInput.addEventListener("input", async () => {
  const query = searchInput.value.trim();
  if (query.length < 2) {
    results.innerHTML = "";
    return;
  }

  let url = "";
  if (searchMode === "name") {
    url = `https://apis.data.go.kr/B551182/diseaseInfoService1/getDissNameCodeList1?serviceKey=9jWsdcJJtTH%2FYu8xzkqAZk72R8HNcZPTG4z1A2PbCvRcOhZ4Hlwnyquk8Z34Ea2kgahuKjnAlzl4gkveRzcsJA%3D%3D&numOfRows=20&pageNo=1&sickType=1&medTp=1&diseaseType=SICK_NM&searchText=${query}`;
  } else if (searchMode === "code") {
    url = `https://apis.data.go.kr/B551182/diseaseInfoService1/getDissNameCodeList1?serviceKey=9jWsdcJJtTH%2FYu8xzkqAZk72R8HNcZPTG4z1A2PbCvRcOhZ4Hlwnyquk8Z34Ea2kgahuKjnAlzl4gkveRzcsJA%3D%3D&numOfRows=20&pageNo=1&sickType=1&medTp=1&diseaseType=SICK_CD&searchText=${query}`;
  } else {
    return;
  }

  try {
    const res = await fetch(url);
    const textData = await res.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(textData, "application/xml");

    const items = xmlDoc.getElementsByTagName("item");
    if (items.length > 0) {
      results.innerHTML = Array.from(items).map(item => {
        const sickNM = item.getElementsByTagName("sickNm")[0]?.textContent || "정보 없음";
        const sickCd = item.getElementsByTagName("sickCd")[0]?.textContent || "정보 없음";
        return `<li onclick="goToResultPage('${encodeURIComponent(sickCd)}', '${encodeURIComponent(sickNM)}')"><strong>${sickNM}</strong> - ${sickCd}</li>`;

      }).join("");
    } else {
      results.innerHTML = "<li>검색 결과가 없습니다.</li>";
    }
  } catch (err) {
    console.error(err);
    results.innerHTML = "<li>API 오류 발생</li>";
  }
});

// 검색 결과 클릭 시 메시지 이동
function goToResultPage(sickCode, SickName) {
  let a = sickCode.charAt(0)
  window.location.href = `next?Code=${a}&Name=${String(SickName)}`;
}
