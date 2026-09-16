import { SVGProps } from "preact/compat";

export function LightBulbIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M10 22H14M8 15H16M5 9C5 7.14348 5.7375 5.36301 7.05025 4.05025C8.36301 2.7375 10.1435 2 12 2C13.8565 2 15.637 2.7375 16.9497 4.05025C18.2625 5.36301 19 7.14348 19 9C19.0008 10.1271 18.7283 11.2376 18.2058 12.2363C17.6833 13.235 16.9264 14.092 16 14.734L15.458 17.3C15.3862 17.773 15.1473 18.2046 14.7846 18.5165C14.4219 18.8284 13.9594 18.9999 13.481 19H10.519C10.0406 18.9999 9.57811 18.8284 9.21539 18.5165C8.85267 18.2046 8.61376 17.773 8.542 17.3L8 14.745C7.07329 14.1007 6.31636 13.2417 5.79393 12.2412C5.27149 11.2407 4.99909 10.1287 5 9Z"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
