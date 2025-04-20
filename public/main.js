const searchInput = document.getElementById("searchInput");
const results = document.getElementById("results");
const editBtn = document.getElementById("editBtn");
const extraOptions = document.getElementById("extraOptions");

let cancerList = [];

// JSON 로드
fetch("cancers.json")
  .then(res => res.json())
  .then(data => {
    cancerList = data;
  })
  .catch(err => {
    console.error("JSON 로딩 실패:", err);
  });

// 검색 입력 이벤트
searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim();
  if (query.length < 1) {
    results.innerHTML = "";
    return;
  }

  const filtered = cancerList.filter(name => name.includes(query));

  results.innerHTML = filtered.length > 0
    ? filtered.map(name => `<li onclick="selectCancer('${name}')">${name}</li>`).join("")
    : "<li>검색 결과가 없습니다.</li>";
});

// 암 선택 시 input에 값 넣고 비활성화
function selectCancer(name) {
  searchInput.value = name;
  searchInput.setAttribute("readonly", true);
  editBtn.classList.remove("hidden");
  results.innerHTML = "";
  extraOptions.classList.remove("hidden");
}

// 연필 버튼 누르면 수정 가능
editBtn.addEventListener("click", () => {
  searchInput.removeAttribute("readonly");
  searchInput.focus();
  editBtn.classList.add("hidden");
  extraOptions.classList.add("hidden");
});
