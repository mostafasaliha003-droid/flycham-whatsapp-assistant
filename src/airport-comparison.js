'use strict';
const {airportCode}=require('./airports');
function flyChamAirportRequests(request){
 const origin=airportCode(request.origin),destination=airportCode(request.destination);
 if(!['SHJ','DXB','AUH','DWC'].includes(origin)||!['DAM','ALP'].includes(destination))return [];
 return ['الشارقة','دبي'].filter(name=>airportCode(name)!==origin).map(name=>({...structuredClone(request),origin:name,provider:'flycham'}));
}
module.exports={flyChamAirportRequests};
