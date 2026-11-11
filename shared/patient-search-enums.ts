/** Source codes with stable display values used by patient search. */
export const patientType = { '0': '治疗', '1': '测试', '2': '科研' };
export const radiationType = { '1': '光子', '2': '电子', '3': '质子', '4': '后装' };
export const idType = { '1': '身份证', '2': '社保卡', '3': '未知', '4': '驾驶证' };

export const patientSearchEnumValues = new Map<string, ReadonlySet<string>>([
  ['患者类型', new Set(Object.values(patientType))],
  ['放疗类型', new Set(Object.values(radiationType))],
  ['证件类型', new Set(Object.values(idType))],
]);
