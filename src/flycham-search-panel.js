'use strict';
// Observed supplier UI: Reset can leave search fields collapsed after a fare.
// Only the icon expands the panel; clicking the adjacent label has no effect.
async function revealFlyChamSearchPanel(frame){
 if(await frame.locator('#fAirport:visible').count()===1||await frame.locator('#fAirport').count()!==1)return false;
 const label=frame.locator('#trSearchParams_label:visible'),icon=frame.locator('#trSearchParams_icon:visible');
 if(await label.count()!==1||(await label.innerText()).replace(/\s+/g,' ').trim()!=='Show search panel'||await icon.count()!==1)return false;
 await icon.click({timeout:5000});await frame.locator('#fAirport:visible').waitFor({state:'visible',timeout:5000});return true;
}
module.exports={revealFlyChamSearchPanel};
