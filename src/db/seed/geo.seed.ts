import { municipalities, provinces } from '../../modules/geo/geo.schema.js';
import { db, sqlClient } from '../client.js';

// Cuba's 15 provinces + the special municipality Isla de la Juventud,
// listed here alongside it as a 16th entry since the app treats it the
// same way (a province containing exactly one municipality).
//
// Reconstructed from general knowledge, not copied from an official
// source — the province list and municipality counts (168 total,
// matching Cuba's known official count) are solid, but a few individual
// municipality names are worth checking against an authoritative source
// (e.g. ONEI, Cuba's national statistics office) before this is treated
// as production-accurate.
//
// English names default to the Spanish name — Cuban place names generally
// aren't translated — except the two well-known exonyms below.
interface ProvinceSeed {
  code: string;
  nameEs: string;
  nameEn: string;
  municipalities: string[];
}

const PROVINCES: ProvinceSeed[] = [
  {
    code: 'PRI',
    nameEs: 'Pinar del Río',
    nameEn: 'Pinar del Río',
    municipalities: [
      'Pinar del Río',
      'Consolación del Sur',
      'Guane',
      'La Palma',
      'Los Palacios',
      'Mantua',
      'Minas de Matahambre',
      'San Juan y Martínez',
      'San Luis',
      'Sandino',
      'Viñales',
    ],
  },
  {
    code: 'ART',
    nameEs: 'Artemisa',
    nameEn: 'Artemisa',
    municipalities: [
      'Artemisa',
      'Alquízar',
      'Bahía Honda',
      'Bauta',
      'Caimito',
      'Candelaria',
      'Guanajay',
      'Güira de Melena',
      'Mariel',
      'San Antonio de los Baños',
      'San Cristóbal',
    ],
  },
  {
    code: 'LHA',
    nameEs: 'La Habana',
    nameEn: 'Havana',
    municipalities: [
      'Playa',
      'Plaza de la Revolución',
      'Centro Habana',
      'La Habana Vieja',
      'Regla',
      'La Habana del Este',
      'Guanabacoa',
      'San Miguel del Padrón',
      'Diez de Octubre',
      'Cerro',
      'Marianao',
      'La Lisa',
      'Boyeros',
      'Arroyo Naranjo',
      'Cotorro',
    ],
  },
  {
    code: 'MAY',
    nameEs: 'Mayabeque',
    nameEn: 'Mayabeque',
    municipalities: [
      'San José de las Lajas',
      'Batabanó',
      'Bejucal',
      'Güines',
      'Jaruco',
      'Madruga',
      'Melena del Sur',
      'Nueva Paz',
      'Quivicán',
      'San Nicolás',
      'Santa Cruz del Norte',
    ],
  },
  {
    code: 'MTZ',
    nameEs: 'Matanzas',
    nameEn: 'Matanzas',
    municipalities: [
      'Matanzas',
      'Calimete',
      'Cárdenas',
      'Ciénaga de Zapata',
      'Colón',
      'Jagüey Grande',
      'Jovellanos',
      'Limonar',
      'Los Arabos',
      'Martí',
      'Pedro Betancourt',
      'Perico',
      'Unión de Reyes',
    ],
  },
  {
    code: 'CFG',
    nameEs: 'Cienfuegos',
    nameEn: 'Cienfuegos',
    municipalities: ['Cienfuegos', 'Abreus', 'Aguada de Pasajeros', 'Cruces', 'Cumanayagua', 'Lajas', 'Palmira', 'Rodas'],
  },
  {
    code: 'VCL',
    nameEs: 'Villa Clara',
    nameEn: 'Villa Clara',
    municipalities: [
      'Santa Clara',
      'Caibarién',
      'Camajuaní',
      'Cifuentes',
      'Corralillo',
      'Encrucijada',
      'Manicaragua',
      'Placetas',
      'Quemado de Güines',
      'Ranchuelo',
      'Remedios',
      'Sagua la Grande',
      'Santo Domingo',
    ],
  },
  {
    code: 'SSP',
    nameEs: 'Sancti Spíritus',
    nameEn: 'Sancti Spíritus',
    municipalities: ['Sancti Spíritus', 'Cabaiguán', 'Fomento', 'Jatibonico', 'La Sierpe', 'Taguasco', 'Trinidad', 'Yaguajay'],
  },
  {
    code: 'CAV',
    nameEs: 'Ciego de Ávila',
    nameEn: 'Ciego de Ávila',
    municipalities: [
      'Ciego de Ávila',
      'Baraguá',
      'Bolivia',
      'Chambas',
      'Ciro Redondo',
      'Florencia',
      'Majagua',
      'Morón',
      'Primero de Enero',
      'Venezuela',
    ],
  },
  {
    code: 'CMG',
    nameEs: 'Camagüey',
    nameEn: 'Camagüey',
    municipalities: [
      'Camagüey',
      'Carlos Manuel de Céspedes',
      'Esmeralda',
      'Florida',
      'Guáimaro',
      'Jimaguayú',
      'Minas',
      'Najasa',
      'Nuevitas',
      'Santa Cruz del Sur',
      'Sibanicú',
      'Sierra de Cubitas',
      'Vertientes',
    ],
  },
  {
    code: 'LTU',
    nameEs: 'Las Tunas',
    nameEn: 'Las Tunas',
    municipalities: ['Las Tunas', 'Amancio', 'Colombia', 'Jesús Menéndez', 'Jobabo', 'Majibacoa', 'Manatí', 'Puerto Padre'],
  },
  {
    code: 'GRA',
    nameEs: 'Granma',
    nameEn: 'Granma',
    municipalities: [
      'Bayamo',
      'Bartolomé Masó',
      'Buey Arriba',
      'Campechuela',
      'Cauto Cristo',
      'Guisa',
      'Jiguaní',
      'Manzanillo',
      'Media Luna',
      'Niquero',
      'Pilón',
      'Río Cauto',
      'Yara',
    ],
  },
  {
    code: 'HOL',
    nameEs: 'Holguín',
    nameEn: 'Holguín',
    municipalities: [
      'Holguín',
      'Antilla',
      'Báguanos',
      'Banes',
      'Cacocum',
      'Calixto García',
      'Cueto',
      'Frank País',
      'Gibara',
      'Mayarí',
      'Moa',
      'Rafael Freyre',
      'Sagua de Tánamo',
      'Urbano Noris',
    ],
  },
  {
    code: 'SCU',
    nameEs: 'Santiago de Cuba',
    nameEn: 'Santiago de Cuba',
    municipalities: [
      'Santiago de Cuba',
      'Contramaestre',
      'Guamá',
      'Mella',
      'Palma Soriano',
      'San Luis',
      'Segundo Frente',
      'Songo-La Maya',
      'Tercer Frente',
    ],
  },
  {
    code: 'GTM',
    nameEs: 'Guantánamo',
    nameEn: 'Guantánamo',
    municipalities: [
      'Guantánamo',
      'Baracoa',
      'Caimanera',
      'El Salvador',
      'Imías',
      'Maisí',
      'Manuel Tames',
      'Niceto Pérez',
      'San Antonio del Sur',
      'Yateras',
    ],
  },
  {
    code: 'IJU',
    nameEs: 'Isla de la Juventud',
    nameEn: 'Isle of Youth',
    municipalities: ['Isla de la Juventud'],
  },
];

async function main(): Promise<void> {
  let provinceCount = 0;
  let municipalityCount = 0;

  for (const province of PROVINCES) {
    const [row] = await db
      .insert(provinces)
      .values({ code: province.code, nameEs: province.nameEs, nameEn: province.nameEn })
      .onConflictDoUpdate({
        target: provinces.code,
        set: { nameEs: province.nameEs, nameEn: province.nameEn },
      })
      .returning();
    if (!row) {
      throw new Error(`Upsert of province "${province.code}" returned no row`);
    }
    provinceCount += 1;

    for (const nameEs of province.municipalities) {
      await db
        .insert(municipalities)
        .values({ provinceId: row.id, nameEs, nameEn: nameEs })
        .onConflictDoUpdate({
          target: [municipalities.provinceId, municipalities.nameEs],
          set: { nameEn: nameEs },
        });
      municipalityCount += 1;
    }
  }

  console.log(`Seeded ${provinceCount} provinces and ${municipalityCount} municipalities.`);
}

main()
  .then(async () => {
    await sqlClient.end();
  })
  .catch(async (err: unknown) => {
    console.error('Geo seed failed:', err);
    await sqlClient.end();
    process.exitCode = 1;
  });
