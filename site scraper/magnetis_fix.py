import csv
import sys
from pathlib import Path

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "sbl_indications.csv"
TXT_PATH = sys.argv[2] if len(sys.argv) > 2 else "sbl_indications.txt"

TARGET_URL = "https://sblglobal.com/product/magnetis-polus-australis-2408"

CLEAN_TEXT = """Nervous System and General Sensitivity
- Magnetis polus australis aids in jerking, tingling, and electric shock-like sensations in arms and limbs.
- Supports sudden lassitude, particularly during walking, often accompanied by anxiety and heat.
- Assists in managing over-excitability, general body lightness, and tremulous respiration.
- Helps individuals oversensitive to cold, especially in the nose, ears, hands, and feet.
- Manages over excitement and aversion to conversation or cheerful surroundings.

Urinary and Pelvic Discomfort
- Helps in involuntary urine emission at night due to sphincter paralysis.
- Supports dribbling urination with urethral numbness and torpor.
- Aids in frequent urination at night and a feeble urinary stream.
- Assists with sensations of inguinal ring dilation and abdominal pressure, suggesting hernia predisposition, with painful sensibility of that part, when coughing.

Sexual Trouble (Male & Female)
- Aids in highly strong tendency for emissions and sexual hyperexcitability, even in paralytic patients.
- Supports impotence with abrupt loss of desire at the moment of peak arousal.
- Helps with painful testicular retraction, swelling, and tearing sensations.
- Assists in managing profuse, early menses and uterine bleeding between periods.

Musculoskeletal and Joint Affections
- Helps with easy joint dislocations, particularly of the foot, from missteps.
- Aids in tearing, wrenching, or pressive pain in knees, patella, lumbar, and sacral areas.
- Supports in jerking, throbbing hamstrings and spontaneous leg contractions.
- Assists in contusive, bruised-like pain throughout joints and limbs, with drawings in fingers, joints of fingers, feet, and ankles.

Skin Sensitivity and Ingrown Nails
- Supports painful sensitivity and throbbing in nail roots, especially big toes as if suppurate.
- Aids in management of ingrown toenails and inflammation in nail beds.
- Helps in frostbite susceptibility in extremities under moderate cold.
- Assists in assisting panaritium with tingling, heat, or throbbing in fingertips.

Palpitations and Erratic Sensations
- Helps with violent palpitations and burning heat in the cardiac region.
- Aids in managing erratic heart sensations, such as the perception that the heart isn't beating.

Chest and Respiratory Distress
- Supports in chest oppression with cool, tremulous breathing.
- Assists with cough and coryza with greenish mucus and shortness of breath.
- Helps in night-time cough attacks during sleep, often fetid in nature.
- Aids in compulsive sighing and involuntary swallowing linked to breathing discomfort.

Digestive Issues
- Manages flatulent colic with pinching and bloating in the abdomen.
- Aids in excessive borborygmi, abdominal noises, and griping.
- Supports metallic, sour, or sweetish taste under and on the tongue.
- Helps with loss of appetite and indifference to food, drink, or tobacco smoke.
- Assists bulimic hunger at noon or during chills, and stomach aching with mental exertion.

Mental Irritability
- Aids in managing moroseness, irritability, and aversion to social interaction.
- Supports emotional instability, inner rage, and dislike of laughter or cheer.
- Assists in cases of mental unrest, unstable thoughts, and dislike to society.

Headache and Vertigo
- Helps in vertigo resembling intoxication, with staggering gait.
- Supports rush of blood to the head in the early morning while still in bed.
- Aids in heaviness, tingling, tearing, and shock-like sensations in the head.

Dryness of Eyes and Amblyopia
- Assists in dryness and burning of eyelids, especially on movement.
- Helps with lachrymation and temporary visual dimness (amblyopia).

Salivation and Burning
- Magnetis polus australis helps with excess watery saliva and embarrassed speech due to tongue swelling.
- Aids in burning sensations in the gullet.

Soft Stool and Rectal Discomfort
- Assists with soft stools preceded by griping and bloating.
- Helps with the sensation of needing to pass gas followed by loose stools.
- Supports constricted rectum and anus preventing wind expulsion.

Upper and Lower Limbs Jerking and Tingling
- Aids in jerking, tingling, and throbbing sensations in arms and legs.
- Supports painful, rapid jerks, and spontaneous movement in hamstrings.
- Assists in managing fatigue, pain from letting feet hang, and pressive tearing pain in the patella.

Sleepiness and Confusing Dreams
- Helps with irresistible drowsiness in the evening and morning but inability to fall asleep.
- Supports insomnia with mental overactivity and fatiguing meditation.
- Aids in frightful, confusing, and repetitive dreams, often with disturbing themes like fires.
- Assists in noisy snoring before midnight and head congestion that requires elevated sleeping posture.

Fever and Cold Sensitivity
- Helps those with dread of open air, feeling deeply chilled even in warmth.
- Magnetis polus australis aids in shuddering with trembling, tossing, and head heat without true fever.
- Supports heat confined to the head and face with ill-humour and inclination to weep."""


def main():
    if not Path(CSV_PATH).exists():
        print(f"Can't find {CSV_PATH} - run this from your project folder.")
        return

    with open(CSV_PATH, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    found = False
    for row in rows:
        if row["url"] == TARGET_URL:
            row["indications"] = CLEAN_TEXT
            row["char_count"] = str(len(CLEAN_TEXT))
            row["flag"] = ""
            found = True
            break

    if not found:
        print("URL not found in CSV - nothing changed.")
        return

    with open(CSV_PATH, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    # Regenerate the txt export from the corrected CSV
    with open(TXT_PATH, "w", encoding="utf-8") as out:
        for row in rows:
            out.write(f"## {row['product_name']}\nURL: {row['url']}\n")
            if row.get("flag"):
                out.write(f"[FLAG: {row['flag']}]\n")
            out.write(f"\n{row['indications'] or '[No indications text found]'}\n\n---\n\n")

    print(f"Updated MAGNETIS POLUS AUSTRALIS: {len(CLEAN_TEXT)} chars, flag cleared.")
    print(f"{CSV_PATH} and {TXT_PATH} rewritten.")


if __name__ == "__main__":
    main()
